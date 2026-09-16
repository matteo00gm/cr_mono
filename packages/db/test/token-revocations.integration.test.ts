import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { REVOCATION_SWEEP_GRACE_SEC } from '../src/revocation-grace.js';
import { isTokenRevoked, pruneLapsedRevocations } from '../src/token-revocations.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `token_revocations` against real Postgres (P0-35).
 *
 * Revocation behaviour belongs to P2-15, which tests it through the verify
 * middleware. What is asserted here is what the schema itself guarantees.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** unique_violation. */
const UNIQUE_VIOLATION = '23505';
/** not_null_violation. */
const NOT_NULL_VIOLATION = '23502';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let admin: DbClient | undefined;
let adminDb: Database;
let db: Database;
let tenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  // The cascade below is a property of the foreign key, not of the runtime
  // role — and since P0-33a revoked DELETE on `tenants` from app_rw, only a
  // role that still holds it can exercise the cascade at all.
  admin = createDbClient(started.adminUrl, { max: 1 });
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await admin?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  tenantId = await createTenant(db, 'tok');
});

const revoke = (jti: string, expiresAt = '2026-12-31T00:00:00Z') =>
  db.execute(sql`
    insert into token_revocations (jti, tenant_id, expires_at)
    values (${jti}, ${tenantId}::uuid, ${expiresAt}::timestamptz)
  `);

describe('token_revocations', () => {
  it('revokes a token', async () => {
    await revoke('jti-one');

    const rows = await db.execute(sql`select 1 from token_revocations where jti = 'jti-one'`);

    expect([...rows]).toHaveLength(1);
  });

  it('treats revoking twice as already revoked, not as a new fact', async () => {
    // P4-06 removes a domain and revokes every token issued to it. Doing that
    // twice — a retry, or two admins at once — must not be an error the caller
    // has to distinguish from a real failure.
    await revoke('jti-dup');
    const error = await revoke('jti-dup').catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('refuses a revocation with no expiry', async () => {
    // A row with no expiry could never be swept, so the list would grow
    // without bound and the sweep's cheapness argument would quietly fail.
    const error = await db
      .execute(
        sql`insert into token_revocations (jti, tenant_id) values ('jti-noexp', ${tenantId}::uuid)`,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(NOT_NULL_VIOLATION);
  });

  it('lets the sweep delete rows past expiry', async () => {
    // Deliberately deletable, unlike the P0-30 to P0-32 ledgers: an expired
    // token cannot be replayed whether or not it is listed here.
    await revoke('jti-expired', '2020-01-01T00:00:00Z');
    await db.execute(sql`delete from token_revocations where expires_at < now()`);

    const rows = await db.execute(sql`select 1 from token_revocations where jti = 'jti-expired'`);

    expect([...rows]).toHaveLength(0);
  });

  it('goes with its tenant', async () => {
    await revoke('jti-tenant');
    // As admin, for the reason in the outbox suite: this asserts the foreign
    // key, and app_rw no longer holds DELETE on `tenants` (P0-33a). A
    // revocation list for a tenant that no longer exists revokes nothing.
    await adminDb.execute(sql`delete from tenants where id = ${tenantId}::uuid`);

    const rows = await db.execute(sql`select 1 from token_revocations where jti = 'jti-tenant'`);

    expect([...rows]).toHaveLength(0);
  });
});

describe('isTokenRevoked (P2-12a)', () => {
  it('finds a revoked token, and only that one', async () => {
    await revoke('jti-found');

    await expect(isTokenRevoked(tenantId, 'jti-found', db)).resolves.toBe(true);
    await expect(isTokenRevoked(tenantId, 'jti-never-revoked', db)).resolves.toBe(false);
  });

  it("does not see another tenant's revocation of the same id", async () => {
    // Asked under the tenant a request resolved: the policy answers for that tenant alone.
    await revoke('jti-shared');
    const other = await createTenant(db, 'tok-other');

    await expect(isTokenRevoked(other, 'jti-shared', db)).resolves.toBe(false);
    await expect(isTokenRevoked(tenantId, 'jti-shared', db)).resolves.toBe(true);
  });

  it('still counts a revocation past its expiry, until the sweep removes it', async () => {
    // A session may continue on a token for half an hour after it lapses (P2-12a).
    await revoke('jti-lapsed', '2020-01-01T00:00:00Z');

    await expect(isTokenRevoked(tenantId, 'jti-lapsed', db)).resolves.toBe(true);
  });
});

describe('pruneLapsedRevocations (P2-14)', () => {
  /** A revocation whose token lapsed `secondsAgo` ago, written under its own tenant. */
  const revokeLapsed = (tenant: string, jti: string, secondsAgo: number) =>
    withTenant(
      tenant,
      (tx) =>
        tx.execute(sql`
          insert into token_revocations (jti, tenant_id, expires_at)
          values (${jti}, ${tenant}::uuid, now() - make_interval(secs => ${secondsAgo}))
        `),
      db,
    );

  const unique = (label: string) => `${label}-${randomUUID()}`;

  it("deletes every tenant's revocations once the window has passed, and nothing sooner", async () => {
    const other = await createTenant(db, 'tok-sweep');
    const lapsed = unique('lapsed');
    const otherLapsed = unique('other-lapsed');
    const inWindow = unique('in-window');
    const live = unique('live');

    await revokeLapsed(tenantId, lapsed, REVOCATION_SWEEP_GRACE_SEC + 60);
    await revokeLapsed(other, otherLapsed, REVOCATION_SWEEP_GRACE_SEC + 60);
    await revokeLapsed(tenantId, inWindow, REVOCATION_SWEEP_GRACE_SEC - 60);
    await revokeLapsed(tenantId, live, -600);

    expect(await pruneLapsedRevocations(1_000, db)).toBeGreaterThanOrEqual(2);

    await expect(isTokenRevoked(tenantId, lapsed, db)).resolves.toBe(false);
    await expect(isTokenRevoked(other, otherLapsed, db)).resolves.toBe(false);
    // A continuation could still present this token, so its revocation has to stay.
    await expect(isTokenRevoked(tenantId, inWindow, db)).resolves.toBe(true);
    await expect(isTokenRevoked(tenantId, live, db)).resolves.toBe(true);
  });

  it('deletes no more than its batch in one statement', async () => {
    for (let index = 0; index < 3; index += 1) {
      await revokeLapsed(tenantId, unique('batch'), REVOCATION_SWEEP_GRACE_SEC + 60);
    }

    expect(await pruneLapsedRevocations(2, db)).toBe(2);
  });

  describe('the flag on its own (ADR 0023)', () => {
    /** A transaction holding the sweep flag and no tenant, whatever the connection had before. */
    const asSweeper = <T>(
      fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
    ) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
        await tx.execute(sql`select set_config('app.revocation_sweeper', 'on', true)`);
        return fn(tx);
      });

    const failureCode = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) => pgErrorCode(error) ?? (error as { code?: string }).code,
      );

    it('cannot see or delete a revocation the window still covers', async () => {
      const inWindow = unique('guarded');
      await revokeLapsed(tenantId, inWindow, REVOCATION_SWEEP_GRACE_SEC - 60);

      const seen = await asSweeper((tx) =>
        tx.execute(sql`select 1 from token_revocations where jti = ${inWindow}`),
      );
      const deleted = await asSweeper((tx) =>
        tx.execute(sql`delete from token_revocations where jti = ${inWindow} returning 1`),
      );

      expect([...seen]).toHaveLength(0);
      expect([...deleted]).toHaveLength(0);
      await expect(isTokenRevoked(tenantId, inWindow, db)).resolves.toBe(true);
    });

    it('cannot write a revocation, or move a lapsed one back into the window', async () => {
      const lapsed = unique('immovable');
      await revokeLapsed(tenantId, lapsed, REVOCATION_SWEEP_GRACE_SEC + 60);

      const inserted = failureCode(
        asSweeper((tx) =>
          tx.execute(sql`
            insert into token_revocations (jti, tenant_id, expires_at)
            values (${unique('forged')}, ${tenantId}::uuid, now())
          `),
        ),
      );
      const moved = failureCode(
        asSweeper((tx) =>
          tx.execute(sql`update token_revocations set expires_at = now() where jti = ${lapsed}`),
        ),
      );

      // insufficient_privilege: the row fails WITH CHECK, which the flag is not part of.
      await expect(inserted).resolves.toBe('42501');
      await expect(moved).resolves.toBe('42501');
    });
  });
});
