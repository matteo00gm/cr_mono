import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import {
  insertKeys,
  readActiveKeys,
  readKeyInGrace,
  replaceSecretKey,
  rotatePublicKey,
} from '../src/widget-keys-write.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant as createScopedTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `widget_keys` against real Postgres (P0-25).
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let admin: DbClient | undefined;
let adminDb: Database;
let db: Database;
let racing: DbClient | undefined;

/**
 * Creates a tenant and leaves the session scoped to it (P0-37).
 *
 * Delegates rather than inserting directly: `tenants` now carries
 * `WITH CHECK (id = app.tenant_id)`, so the id has to exist before the row
 * does. Creating a second tenant therefore *moves* the context — tests that
 * span two tenants have to say which one they mean, with `useTenant`.
 */
const createTenant = (slug: string): Promise<string> => createScopedTenant(db, slug);

interface KeyRow {
  publicKey: string;
  secret: string;
}

/**
 * Stands in for the real key minting (P4-09), which hashes with SHA-256 (ADR 0025).
 *
 * SHA-256 here on purpose: this suite is about what the *table* guarantees, and
 * pulling in an argon2 binding to prove a column holds "a hash" would test the
 * binding. The property asserted below — the plaintext secret appears in no
 * column — holds for any hash and is the one worth catching early.
 */
const mintKey = (): KeyRow => {
  const secret = `sk_live_${randomBytes(24).toString('hex')}`;
  return { publicKey: `pk_live_${randomBytes(16).toString('hex')}`, secret };
};

const insertKey = (tenantId: string, key: KeyRow) =>
  db.execute(sql`
    insert into widget_keys (
      tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4
    )
    values (
      ${tenantId}::uuid,
      ${key.publicKey},
      ${createHash('sha256').update(key.secret).digest('hex')},
      ${key.secret.slice(0, 8)},
      ${key.secret.slice(-4)}
    )
    returning id
  `);

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  /*
   * A second pool, of two, for the one case that needs two transactions open at
   * once. The suite's own pool is a single connection on purpose — it is how
   * this file proves a tenant context does not survive on a reused connection —
   * and a single connection is also exactly what makes a race impossible: the
   * second transaction cannot start until the first has finished.
   */
  racing = createDbClient(started.roleUrl('app_rw'), { max: 2 });

  // The cascade these suites assert is a property of the foreign key, not of
  // the runtime role — and P0-33a revoked DELETE on `tenants` from app_rw, so
  // only a role that still holds it can trigger the cascade at all.
  admin = createDbClient(started.adminUrl, { max: 1 });
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await racing?.close();
  await client?.close();
  await admin?.close();
  await container?.stop();
}, 60_000);

describe('widget_keys', () => {
  it('stores no column containing the raw secret', async () => {
    /*
     * The mistake worth catching, asserted against the row rather than the
     * schema: every text column of the stored row is searched for the secret.
     * A future column that helpfully caches the plaintext fails here without
     * anyone having to remember to update this test.
     */
    const tenantId = await createTenant('no-plaintext');
    const key = mintKey();
    await insertKey(tenantId, key);

    const rows = await db.execute(
      sql`select to_jsonb(w) as row from widget_keys w where tenant_id = ${tenantId}::uuid`,
    );

    expect(JSON.stringify([...rows][0]?.row)).not.toContain(key.secret);
  });

  it('keeps enough to identify a key without being able to use it', async () => {
    const tenantId = await createTenant('identifiable');
    const key = mintKey();
    await insertKey(tenantId, key);

    const rows = await db.execute(
      sql`select secret_key_prefix, secret_key_last4 from widget_keys
          where tenant_id = ${tenantId}::uuid`,
    );
    const stored = [...rows][0];

    expect(key.secret.startsWith(String(stored?.secret_key_prefix))).toBe(true);
    expect(key.secret.endsWith(String(stored?.secret_key_last4))).toBe(true);
  });

  it('refuses a second active key for the same tenant', async () => {
    const tenantId = await createTenant('one-active');
    await insertKey(tenantId, mintKey());

    const error = await insertKey(tenantId, mintKey()).catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('allows a new key once the previous one is revoked', async () => {
    // Rotation, which the partial index exists to permit. A plain unique on
    // tenant_id would make this impossible.
    const tenantId = await createTenant('rotatable');
    await insertKey(tenantId, mintKey());

    await db.execute(sql`
      update widget_keys
      set revoked_at = now(), grace_until = now() + interval '24 hours'
      where tenant_id = ${tenantId}::uuid
    `);

    await expect(insertKey(tenantId, mintKey())).resolves.toBeDefined();

    const rows = await db.execute(
      sql`select count(*)::int as total from widget_keys where tenant_id = ${tenantId}::uuid`,
    );
    // Both rows are still there: the old one has to survive its grace window.
    expect([...rows][0]?.total).toBe(2);
  });

  it('refuses a grace window on a key that was never revoked', async () => {
    // A live key with a grace window is the shape of a bug that keeps a
    // compromised key alive.
    const tenantId = await createTenant('grace-guard');
    const key = mintKey();

    const error = await db
      .execute(
        sql`insert into widget_keys (
              tenant_id, public_key, secret_key_hash, secret_key_prefix,
              secret_key_last4, grace_until
            )
            values (
              ${tenantId}::uuid, ${key.publicKey}, 'hash', 'sk_live_', 'abcd',
              now() + interval '24 hours'
            )`,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('keeps public keys unique across tenants', async () => {
    // A public key identifies a tenant. Two tenants sharing one is the same
    // failure UNIQUE(origin) prevents on the other side of the handshake.
    // Each key is written under its own tenant's context, since WITH CHECK
    // permits nothing else. Creating the second tenant moves the context, so
    // the first key is written before that happens. The unique index still
    // spans both: the second tenant cannot see the first key and is refused
    // by it anyway, which is exactly the guarantee.
    const key = mintKey();
    const first = await createTenant('pk-first');
    await insertKey(first, key);

    const second = await createTenant('pk-second');

    const error = await insertKey(second, key).catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('deletes keys when the tenant is deleted', async () => {
    const tenantId = await createTenant('key-cascade');
    await insertKey(tenantId, mintKey());

    await adminDb.execute(sql`delete from tenants where id = ${tenantId}::uuid`);

    const rows = await db.execute(
      sql`select 1 from widget_keys where tenant_id = ${tenantId}::uuid`,
    );
    expect([...rows]).toHaveLength(0);
  });
});

describe('issuing and rotating keys (P4-09)', () => {
  /*
   * Against real Postgres because the properties are about what lands in the
   * columns, and a fake would be asserting itself. The statements are handed a
   * hash here — which is all they are ever handed — and the assertion is that
   * nothing else about the secret reached the row.
   */
  const secret = (): string => `sk_live_${randomBytes(32).toString('hex').slice(0, 43)}`;
  const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

  it('stores the hash and the hint, and no column holds the key', async () => {
    const tenantId = await createTenant(`keys-issue-${randomBytes(3).toString('hex')}`);
    const key = secret();

    const issued = await withTenant(
      tenantId,
      (tx) =>
        insertKeys(tx, {
          publicKey: `pk_live_${randomBytes(12).toString('hex')}`,
          secretKeyHash: sha(key),
          secretKeyPrefix: key.slice(0, 12),
          secretKeyLast4: key.slice(-4),
        }),
      db,
    );

    expect(issued?.secretKeyLast4).toBe(key.slice(-4));

    /* Every column of the row, read as the owner would, searched for the key. */
    const rows = await adminDb.execute(
      sql`SELECT * FROM widget_keys WHERE tenant_id = ${tenantId}::uuid`,
    );
    const everything = JSON.stringify([...rows]);

    expect(everything).not.toContain(key);
    expect(everything).not.toContain(key.slice(12, 30));
    expect(everything).toContain(sha(key));
  });

  it('never selects the hash back out', async () => {
    /* A hash of a key can be replayed against anything that trusts a hash. It
     * has no business leaving the database on any path. */
    const tenantId = await createTenant(`keys-read-${randomBytes(3).toString('hex')}`);
    const key = secret();

    await withTenant(
      tenantId,
      (tx) =>
        insertKeys(tx, {
          publicKey: `pk_live_${randomBytes(12).toString('hex')}`,
          secretKeyHash: sha(key),
          secretKeyPrefix: key.slice(0, 12),
          secretKeyLast4: key.slice(-4),
        }),
      db,
    );

    const read = await withTenant(tenantId, (tx) => readActiveKeys(tx), db);

    expect(JSON.stringify(read)).not.toContain(sha(key));
  });

  it('refuses a second pair rather than replacing the first', async () => {
    const tenantId = await createTenant(`keys-twice-${randomBytes(3).toString('hex')}`);
    const make = () =>
      withTenant(
        tenantId,
        (tx) =>
          insertKeys(tx, {
            publicKey: `pk_live_${randomBytes(12).toString('hex')}`,
            secretKeyHash: sha(secret()),
            secretKeyPrefix: 'sk_live_AAAA',
            secretKeyLast4: 'ZZZZ',
          }),
        db,
      );

    await expect(make()).resolves.toBeDefined();
    await expect(make()).resolves.toBeUndefined();
  });

  it('rotates the secret in place, leaving the public key live', async () => {
    /*
     * One row, updated — so the public key on the seller's pages keeps working,
     * and the old secret's hash is gone the instant this commits. That is the
     * "no grace" the row asks for.
     */
    const tenantId = await createTenant(`keys-rotate-${randomBytes(3).toString('hex')}`);
    const first = secret();
    const second = secret();
    const publicKey = `pk_live_${randomBytes(12).toString('hex')}`;

    await withTenant(
      tenantId,
      (tx) =>
        insertKeys(tx, {
          publicKey,
          secretKeyHash: sha(first),
          secretKeyPrefix: first.slice(0, 12),
          secretKeyLast4: first.slice(-4),
        }),
      db,
    );

    const rotated = await withTenant(
      tenantId,
      (tx) =>
        replaceSecretKey(tx, {
          secretKeyHash: sha(second),
          secretKeyPrefix: second.slice(0, 12),
          secretKeyLast4: second.slice(-4),
        }),
      db,
    );

    expect(rotated?.publicKey).toBe(publicKey);

    const rows = await adminDb.execute(sql`
      SELECT secret_key_hash FROM widget_keys WHERE tenant_id = ${tenantId}::uuid
    `);
    const hashes = [...rows].map((row) => (row as { secret_key_hash: string }).secret_key_hash);

    expect(hashes).toEqual([sha(second)]);
    expect(hashes).not.toContain(sha(first));
  });

  it('rotates nothing for a winery that has no keys', async () => {
    const tenantId = await createTenant(`keys-none-${randomBytes(3).toString('hex')}`);

    await expect(
      withTenant(
        tenantId,
        (tx) =>
          replaceSecretKey(tx, {
            secretKeyHash: sha(secret()),
            secretKeyPrefix: 'sk_live_AAAA',
            secretKeyLast4: 'ZZZZ',
          }),
        db,
      ),
    ).resolves.toBeUndefined();
  });

  it('cannot reach another winery keys', async () => {
    const owner = await createTenant(`keys-owner-${randomBytes(3).toString('hex')}`);
    const other = await createTenant(`keys-other-${randomBytes(3).toString('hex')}`);

    await withTenant(
      owner,
      (tx) =>
        insertKeys(tx, {
          publicKey: `pk_live_${randomBytes(12).toString('hex')}`,
          secretKeyHash: sha(secret()),
          secretKeyPrefix: 'sk_live_AAAA',
          secretKeyLast4: 'ZZZZ',
        }),
      db,
    );

    await expect(withTenant(other, (tx) => readActiveKeys(tx), db)).resolves.toBeUndefined();
    await expect(
      withTenant(
        other,
        (tx) =>
          replaceSecretKey(tx, {
            secretKeyHash: sha(secret()),
            secretKeyPrefix: 'sk_live_BBBB',
            secretKeyLast4: 'YYYY',
          }),
        db,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('rotating the public key (P4-08)', () => {
  const secret = (): string => `sk_live_${randomBytes(32).toString('hex').slice(0, 43)}`;
  const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
  const pk = (): string => `pk_live_${randomBytes(12).toString('hex')}`;

  const issue = async (tenantId: string, publicKey: string, key = secret()) =>
    withTenant(
      tenantId,
      (tx) =>
        insertKeys(tx, {
          publicKey,
          secretKeyHash: sha(key),
          secretKeyPrefix: key.slice(0, 12),
          secretKeyLast4: key.slice(-4),
        }),
      db,
    );

  const rows = async (tenantId: string) =>
    [
      ...(await adminDb.execute(sql`
        SELECT public_key, revoked_at, grace_until, secret_key_hash,
               grace_until > now() AS in_grace
        FROM widget_keys WHERE tenant_id = ${tenantId}::uuid
        ORDER BY created_at
      `)),
    ] as {
      public_key: string;
      revoked_at: unknown;
      grace_until: unknown;
      secret_key_hash: string;
      in_grace: boolean | null;
    }[];

  it('keeps the old key live for a day and makes the new one active', async () => {
    const tenantId = await createTenant(`rotate-pk-${randomBytes(3).toString('hex')}`);
    const first = pk();
    const second = pk();

    await issue(tenantId, first);

    const rotated = await withTenant(tenantId, (tx) => rotatePublicKey(tx, second), db);

    expect(rotated?.active.publicKey).toBe(second);
    expect(rotated?.previous.publicKey).toBe(first);

    const hours = ((rotated?.previous.graceUntil.getTime() ?? 0) - Date.now()) / (60 * 60 * 1000);

    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);

    const [old, current] = await rows(tenantId);

    expect(old?.public_key).toBe(first);
    expect(old?.revoked_at).not.toBeNull();
    expect(old?.in_grace).toBe(true);
    expect(current?.public_key).toBe(second);
    expect(current?.revoked_at).toBeNull();
  });

  it('carries the secret across, so rotating one key does not rotate the other', async () => {
    /* The secret is on the seller's server. Rotating the public key must not
     * silently invalidate a secret they did not ask to change. */
    const tenantId = await createTenant(`rotate-carry-${randomBytes(3).toString('hex')}`);
    const key = secret();

    await issue(tenantId, pk(), key);
    await withTenant(tenantId, (tx) => rotatePublicKey(tx, pk()), db);

    const current = (await rows(tenantId)).find((row) => row.revoked_at === null);

    expect(current?.secret_key_hash).toBe(sha(key));
  });

  it('leaves at most one old key live, however often it rotates', async () => {
    /*
     * **The rule the row did not state and the one that matters most.** A
     * seller rotates when they think a key has leaked. Rotating twice in a day
     * must not leave the first leaked key working beside the second.
     */
    const tenantId = await createTenant(`rotate-twice-${randomBytes(3).toString('hex')}`);
    const first = pk();
    const second = pk();
    const third = pk();

    await issue(tenantId, first);
    await withTenant(tenantId, (tx) => rotatePublicKey(tx, second), db);
    await withTenant(tenantId, (tx) => rotatePublicKey(tx, third), db);

    const all = await rows(tenantId);
    const live = all.filter((row) => row.revoked_at === null || row.in_grace === true);

    expect(live.map((row) => row.public_key).sort()).toEqual([second, third].sort());
    expect(all.find((row) => row.public_key === first)?.in_grace).toBe(false);
  });

  it('shows the key in grace, and only that one', async () => {
    const tenantId = await createTenant(`rotate-read-${randomBytes(3).toString('hex')}`);
    const first = pk();
    const second = pk();
    const third = pk();

    await issue(tenantId, first);
    await withTenant(tenantId, (tx) => rotatePublicKey(tx, second), db);
    await withTenant(tenantId, (tx) => rotatePublicKey(tx, third), db);

    const inGrace = await withTenant(tenantId, (tx) => readKeyInGrace(tx), db);

    expect(inGrace?.publicKey).toBe(second);
  });

  it('shows nothing once the grace has run out', async () => {
    /*
     * The one case where the deadline decides the answer. Resolution (P2-07)
     * stops accepting the key at `grace_until`, and a dashboard that went on
     * showing it as live would be telling a seller their old snippet still
     * works after it has stopped.
     */
    const tenantId = await createTenant(`rotate-lapsed-${randomBytes(3).toString('hex')}`);
    const first = pk();

    await issue(tenantId, first);
    await withTenant(tenantId, (tx) => rotatePublicKey(tx, pk()), db);
    await adminDb.execute(sql`
      UPDATE widget_keys SET grace_until = now() - interval '1 second'
      WHERE tenant_id = ${tenantId}::uuid AND public_key = ${first}
    `);

    await expect(withTenant(tenantId, (tx) => readKeyInGrace(tx), db)).resolves.toBeUndefined();
  });

  it('shows the newest if two are ever in grace at once', async () => {
    /*
     * Rotation never leaves two — it ends the earlier grace — so this builds
     * the state directly. What is asserted is the read's own contract, which
     * has to hold even if that invariant is ever broken by something else:
     * the key a seller most recently rotated away from is the one they are
     * most likely still to have deployed.
     */
    const tenantId = await createTenant(`rotate-two-${randomBytes(3).toString('hex')}`);
    const older = pk();
    const newer = pk();

    for (const [key, hours] of [
      [older, 2],
      [newer, 20],
    ] as const) {
      await adminDb.execute(sql`
        INSERT INTO widget_keys (
          tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4,
          revoked_at, grace_until
        ) VALUES (
          ${tenantId}::uuid, ${key}, ${sha(secret())}, 'sk_live_AAAA', 'ZZZZ',
          now(), now() + make_interval(hours => ${hours})
        )
      `);
    }

    const inGrace = await withTenant(tenantId, (tx) => readKeyInGrace(tx), db);

    expect(inGrace?.publicKey).toBe(newer);
  });

  it('has nothing in grace before any rotation', async () => {
    const tenantId = await createTenant(`rotate-none-${randomBytes(3).toString('hex')}`);

    await issue(tenantId, pk());

    await expect(withTenant(tenantId, (tx) => readKeyInGrace(tx), db)).resolves.toBeUndefined();
  });

  it('rotates nothing for a winery with no keys', async () => {
    const tenantId = await createTenant(`rotate-empty-${randomBytes(3).toString('hex')}`);

    await expect(
      withTenant(tenantId, (tx) => rotatePublicKey(tx, pk()), db),
    ).resolves.toBeUndefined();
  });

  it('survives two simultaneous rotations, which is what the lock is for', async () => {
    /*
     * Without the lock on the winery's row, both transactions find the same
     * active key. The second blocks on that row, and when the first commits it
     * re-checks, finds the key revoked, updates nothing — and reports that the
     * winery has no keys at all. With the lock, the second waits before it
     * reads anything, then rotates the key the first one made.
     *
     * **It took two rewrites to make this test able to fail.** Two concurrent
     * calls passed with the lock removed, as P4-07's did. Holding the first
     * transaction open still passed — because this suite's pool is a single
     * connection, so the second transaction could not even *begin* until the
     * first had finished. Both runs, the lock was never what was being tested.
     * So this uses a pool of two, and holds the first transaction open while
     * the second starts.
     */
    const pool = racing?.db ?? db;
    const tenantId = await createTenant(`rotate-race-${randomBytes(3).toString('hex')}`);

    await issue(tenantId, pk());

    let holding = (): void => undefined;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withTenant(
      tenantId,
      async (tx) => {
        const result = await rotatePublicKey(tx, pk());

        holding();
        await released;

        return result;
      },
      pool,
    );

    await held;

    const second = withTenant(tenantId, (tx) => rotatePublicKey(tx, pk()), pool);

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
    release();

    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
    expect((await rows(tenantId)).filter((row) => row.revoked_at === null)).toHaveLength(1);
  });

  it('cannot rotate another winery keys', async () => {
    const owner = await createTenant(`rotate-owner-${randomBytes(3).toString('hex')}`);
    const other = await createTenant(`rotate-other-${randomBytes(3).toString('hex')}`);

    await issue(owner, pk());

    await expect(withTenant(other, (tx) => rotatePublicKey(tx, pk()), db)).resolves.toBeUndefined();
    expect((await rows(owner)).filter((row) => row.revoked_at === null)).toHaveLength(1);
  });
});
