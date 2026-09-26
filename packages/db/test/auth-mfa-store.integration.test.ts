import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMfaStore, type AuthMfaStore } from '../src/auth-db.js';
import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The MFA store's SQL against real Postgres (P4-11).
 *
 * The arithmetic that decides whether a code is spent, an account is locked and
 * a session is fresh — every comparison with the clock is the database's, so
 * these move the clock by rewriting timestamps rather than by waiting.
 */

const POLICY = { claimSeconds: 90, maxFailures: 3, lockSeconds: 900, freshSeconds: 900 };

let container: StartedPostgreSqlContainer | undefined;
let clients: DbClient[] = [];
let db: Database;
let adminDb: Database;
let store: AuthMfaStore;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  /* Two connections, so the race below is a race. */
  const app = createDbClient(started.roleUrl('app_rw'), { max: 2 });
  const admin = createDbClient(started.adminUrl, { max: 1 });

  clients = [app, admin];
  db = app.db;
  adminDb = admin.db;
  store = createMfaStore(POLICY, db);
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await container?.stop();
}, 60_000);

/** A user with a second factor and one session. */
const user = async (options: { twoFactorEnabled?: boolean } = {}) => {
  const id = `user_${randomUUID().replaceAll('-', '')}`;
  const token = randomUUID();

  await adminDb.execute(sql`
    INSERT INTO auth_users (id, name, email, two_factor_enabled)
    VALUES (${id}, 'Owner', ${`${id}@example.test`}, ${options.twoFactorEnabled ?? true})
  `);
  await adminDb.execute(sql`
    INSERT INTO auth_two_factor (id, user_id, secret, backup_codes) VALUES (${randomUUID()}, ${id}, 'x', '[]')
  `);
  await adminDb.execute(sql`
    INSERT INTO auth_sessions (id, user_id, token, expires_at)
    VALUES (${randomUUID()}, ${id}, ${token}, now() + interval '1 day')
  `);

  return { id, token };
};

const failures = async (userId: string) => {
  const [row] = [
    ...(await adminDb.execute(sql`
      SELECT failed_verification_count AS count, locked_until IS NOT NULL AS locked
      FROM auth_two_factor WHERE user_id = ${userId}
    `)),
  ] as { count: number; locked: boolean }[];

  return row;
};

describe('claiming a TOTP code', () => {
  it('succeeds once and is refused while the window lasts', async () => {
    const { id } = await user();

    expect(await store.claimTotpCode(id, 'hash-a')).toBe(true);
    expect(await store.claimTotpCode(id, 'hash-a')).toBe(false);
  });

  it("is per user: one person spending a code spends nobody else's", async () => {
    const first = await user();
    const second = await user();

    await store.claimTotpCode(first.id, 'hash-shared');

    expect(await store.claimTotpCode(second.id, 'hash-shared')).toBe(true);
  });

  it('can be claimed again once its window has closed', async () => {
    /* A later step can produce the same six digits; it must not be refused forever. */
    const { id } = await user();
    await store.claimTotpCode(id, 'hash-b');

    await adminDb.execute(sql`
      UPDATE auth_totp_claims SET claimed_at = now() - interval '91 seconds' WHERE user_id = ${id}
    `);

    expect(await store.claimTotpCode(id, 'hash-b')).toBe(true);
    expect(await store.claimTotpCode(id, 'hash-b')).toBe(false);
  });

  it('lets exactly one of two racing claims win', async () => {
    const { id } = await user();

    const results = await Promise.all([
      store.claimTotpCode(id, 'hash-race'),
      store.claimTotpCode(id, 'hash-race'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("sweeps the user's expired claims as it goes", async () => {
    const { id } = await user();
    await store.claimTotpCode(id, 'hash-old');
    await adminDb.execute(sql`
      UPDATE auth_totp_claims SET claimed_at = now() - interval '5 minutes' WHERE user_id = ${id}
    `);

    await store.claimTotpCode(id, 'hash-new');

    const rows = [
      ...(await adminDb.execute(sql`SELECT code_hash FROM auth_totp_claims WHERE user_id = ${id}`)),
    ];
    expect(rows).toEqual([{ code_hash: 'hash-new' }]);
  });
});

describe('the step-up budget', () => {
  it('locks on the last allowed failure, not before', async () => {
    const { id } = await user();

    await store.recordFailure(id);
    await store.recordFailure(id);
    expect(await store.isLocked(id)).toBe(false);

    await store.recordFailure(id);
    expect(await store.isLocked(id)).toBe(true);
  });

  it('starts counting again once a lock has run out, rather than re-locking at once', async () => {
    const { id } = await user();
    for (let i = 0; i < 3; i += 1) await store.recordFailure(id);
    await adminDb.execute(sql`
      UPDATE auth_two_factor SET locked_until = now() - interval '1 second' WHERE user_id = ${id}
    `);

    expect(await store.isLocked(id)).toBe(false);

    await store.recordFailure(id);

    expect(await failures(id)).toEqual({ count: 1, locked: false });
    expect(await store.isLocked(id)).toBe(false);
  });

  it('is cleared by a success', async () => {
    const { id } = await user();
    await store.recordFailure(id);
    await store.recordFailure(id);

    await store.clearFailures(id);

    expect(await failures(id)).toEqual({ count: 0, locked: false });
  });

  it('never locks somebody else', async () => {
    const first = await user();
    const second = await user();

    for (let i = 0; i < 3; i += 1) await store.recordFailure(first.id);

    expect(await store.isLocked(second.id)).toBe(false);
  });
});

describe("a session's freshness", () => {
  it('is stale until a second factor is proved', async () => {
    const { id, token } = await user();

    expect(await store.stepUpState(token)).toEqual({
      userId: id,
      twoFactorEnabled: true,
      fresh: false,
    });
  });

  it('is fresh once stamped, and stale again after fifteen minutes', async () => {
    const { token } = await user();
    await store.markVerified(token);

    expect((await store.stepUpState(token))?.fresh).toBe(true);

    await adminDb.execute(sql`
      UPDATE auth_sessions SET last_verified_at = now() - interval '901 seconds' WHERE token = ${token}
    `);

    expect((await store.stepUpState(token))?.fresh).toBe(false);
  });

  it('is never fresh from a stamp in the future', async () => {
    /* A corrupted or forged stamp must not buy a session fifteen minutes plus. */
    const { token } = await user();
    await adminDb.execute(sql`
      UPDATE auth_sessions SET last_verified_at = now() + interval '1 hour' WHERE token = ${token}
    `);

    expect((await store.stepUpState(token))?.fresh).toBe(false);
  });

  it('is nothing at all for an expired session, whatever a cached copy says', async () => {
    const { token } = await user();
    await store.markVerified(token);
    await adminDb.execute(sql`
      UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE token = ${token}
    `);

    await expect(store.stepUpState(token)).resolves.toBeUndefined();
  });

  it('says whether the user has a second factor at all', async () => {
    const { token } = await user({ twoFactorEnabled: false });

    expect((await store.stepUpState(token))?.twoFactorEnabled).toBe(false);
  });

  it('stamps only the session it is given', async () => {
    const { id, token } = await user();
    const other = randomUUID();
    await adminDb.execute(sql`
      INSERT INTO auth_sessions (id, user_id, token, expires_at)
      VALUES (${randomUUID()}, ${id}, ${other}, now() + interval '1 day')
    `);

    await store.markVerified(token);

    expect((await store.stepUpState(other))?.fresh).toBe(false);
  });
});
