import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { insertKeys, replaceSecretKey, rotatePublicKey } from '../src/widget-keys-write.js';
import { NestedSecretKeyContextError, resolveTenantBySecretKey } from '../src/with-secret-key.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant as createScopedTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The seventh RLS scope, against real Postgres (P4-10, ADR 0026).
 *
 * **Every property here is a property of a policy**, which is why none of it can
 * be a unit test: a fake returns whatever it is told to. What is proved is that
 * the scope reaches exactly one active key row by its hash and nothing else —
 * not a revoked row, not a rotated-away row still carrying the same hash, and
 * nothing of another winery's.
 *
 * **Two connections, and the split is load-bearing.** Seeding goes through
 * `createTenant`, which sets `app.tenant_id` at *session* level so a suite can
 * seed and then read. A resolution that ran on that connection would find its
 * key row through the tenant branch and never exercise the secret one — every
 * test below would pass with the new branch deleted. `db` is never given a
 * session GUC, so what it can see is what the scope admits and nothing more.
 */

let container: StartedPostgreSqlContainer | undefined;
let clients: DbClient[] = [];
let db: Database;
let seedDb: Database;
let adminDb: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  const resolver = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  const seeder = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  const admin = createDbClient(started.adminUrl, { max: 1 });

  clients = [resolver, seeder, admin];
  db = resolver.db;
  seedDb = seeder.db;
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await container?.stop();
}, 60_000);

/** Built at runtime, never written into this file (P0-56). */
const secret = (): string => ['sk', 'live', randomBytes(32).toString('base64url')].join('_');
const pk = (): string => ['pk', 'live', randomBytes(12).toString('hex')].join('_');
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const suffix = (): string => randomBytes(4).toString('hex');

const secretColumns = (key: string) => ({
  secretKeyHash: sha(key),
  secretKeyPrefix: key.slice(0, 12),
  secretKeyLast4: key.slice(-4),
});

/** A winery with keys, one verified origin and one pending claim. */
const winery = async () => {
  const key = secret();
  const tenantId = await createScopedTenant(seedDb, `secret-${suffix()}`);
  const verified = `https://www.w${suffix()}.example`;

  await withTenant(
    tenantId,
    async (tx) => {
      await insertKeys(tx, { publicKey: pk(), ...secretColumns(key) });
      await tx.execute(sql`
        INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status)
        VALUES
          (${tenantId}::uuid, ${verified}, ${`w${suffix()}.example`}, 'VERIFIED'),
          (${tenantId}::uuid, ${`https://shop.w${suffix()}.example`}, ${`w${suffix()}.example`}, 'PENDING')
      `);
    },
    seedDb,
  );

  // A winery that has verified a domain is past onboarding; a new tenant row is not.
  await adminDb.execute(sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantId}::uuid`);

  return { tenantId, key, verified };
};

describe('a server presenting a secret key', () => {
  it('finds the winery the key belongs to', async () => {
    const { tenantId, key } = await winery();

    await expect(resolveTenantBySecretKey(sha(key), db)).resolves.toMatchObject({
      tenantId,
      status: 'ACTIVE',
    });
  });

  it('learns the verified origins, and only the verified ones', async () => {
    /* A session may be minted for these and nothing else. A pending claim is
     * not an origin the widget may be served to. */
    const { key, verified } = await winery();

    const found = await resolveTenantBySecretKey(sha(key), db);

    expect(found?.verifiedOrigins).toEqual([verified]);
  });

  it('finds nothing for a key nobody was issued', async () => {
    await winery();

    await expect(resolveTenantBySecretKey(sha(secret()), db)).resolves.toBeUndefined();
  });

  it("never learns another winery's origins through its own key", async () => {
    /*
     * The hand-over sets `app.tenant_id` from the key row, so everything after
     * it is tenant-scoped. Two wineries, each key finding exactly its own.
     */
    const first = await winery();
    const second = await winery();

    const [a, b] = await Promise.all([
      resolveTenantBySecretKey(sha(first.key), db),
      resolveTenantBySecretKey(sha(second.key), db),
    ]);

    expect(a).toMatchObject({ tenantId: first.tenantId, verifiedOrigins: [first.verified] });
    expect(b).toMatchObject({ tenantId: second.tenantId, verifiedOrigins: [second.verified] });
  });

  it('leaves nothing behind on the connection', async () => {
    /*
     * `set_config(..., true)` is transaction-local. Were it session-level, the
     * next request on this pooled connection would inherit whichever scope the
     * last resolution ended in — a tenant context nobody authenticated.
     */
    const { key } = await winery();

    await resolveTenantBySecretKey(sha(key), db);

    const [row] = [
      ...(await db.execute(sql`
        SELECT current_setting('app.tenant_id', true) AS tenant,
               current_setting('app.secret_key_hash', true) AS hash
      `)),
    ] as { tenant: string | null; hash: string | null }[];

    expect(row?.tenant ?? '').toBe('');
    expect(row?.hash ?? '').toBe('');
  });
});

describe('a key that has stopped being the key', () => {
  it('is not found once the secret is replaced', async () => {
    const { tenantId, key } = await winery();

    await withTenant(tenantId, (tx) => replaceSecretKey(tx, secretColumns(secret())), seedDb);

    await expect(resolveTenantBySecretKey(sha(key), db)).resolves.toBeUndefined();
  });

  it('is found through the new row after a public-key rotation, and only that', async () => {
    /*
     * **The case `revoked_at IS NULL` exists for.** P4-08 carries the secret
     * hash onto the new row, and the revoked row keeps its copy through the
     * grace window — two rows with one hash. The scope must admit the active one
     * alone, or `LIMIT 1` would be choosing between them.
     */
    const { tenantId, key } = await winery();

    await withTenant(tenantId, (tx) => rotatePublicKey(tx, pk()), seedDb);

    const [copies] = [
      ...(await adminDb.execute(sql`
        SELECT count(*)::int AS n FROM widget_keys WHERE secret_key_hash = ${sha(key)}
      `)),
    ] as { n: number }[];

    const visible = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.secret_key_hash', ${sha(key)}, true)`);

      return [...(await tx.execute(sql`SELECT revoked_at FROM widget_keys`))];
    });

    expect(copies?.n).toBe(2);
    expect(visible).toEqual([{ revoked_at: null }]);
    await expect(resolveTenantBySecretKey(sha(key), db)).resolves.toMatchObject({ tenantId });
  });

  it('is not found once every row carrying it is revoked', async () => {
    const { tenantId, key } = await winery();

    await adminDb.execute(sql`
      UPDATE widget_keys SET revoked_at = now() WHERE tenant_id = ${tenantId}::uuid
    `);

    await expect(resolveTenantBySecretKey(sha(key), db)).resolves.toBeUndefined();
  });
});

describe('the scope itself', () => {
  it('admits only the key row, and nothing from any other table', async () => {
    /*
     * ADR 0026's narrowness: one branch, on one table. With only the secret GUC
     * set, the key row is visible and the winery's own tenant row and domains
     * are not — they are reached after the hand-over, under the tenant policy.
     */
    const { key } = await winery();

    const seen = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.secret_key_hash', ${sha(key)}, true)`);

      const count = async (table: string) => {
        const [row] = [
          ...(await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`)),
        ] as { n: number }[];

        return row?.n;
      };

      return {
        keys: await count('widget_keys'),
        tenants: await count('tenants'),
        domains: await count('tenant_domains'),
      };
    });

    expect(seen).toEqual({ keys: 1, tenants: 0, domains: 0 });
  });

  it('admits nothing when the value is empty', async () => {
    /* An unset scope must look exactly like no scope: `nullif` turns '' into a
     * NULL that equals no hash. */
    await winery();

    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.secret_key_hash', '', true)`);

      return [...(await tx.execute(sql`SELECT 1 FROM widget_keys`))];
    });

    expect(rows).toEqual([]);
  });

  it('cannot be used to write a key row it can see', async () => {
    /*
     * The policy's WITH CHECK is tenant-only, so even a writable transaction
     * holding the secret GUC cannot change the row it was admitted to read.
     * The function's own transaction is read-only as well (unit-tested); this
     * is the layer underneath that would still hold without it.
     */
    const { key } = await winery();

    const updated = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.secret_key_hash', ${sha(key)}, true)`);

        return [
          ...(await tx.execute(sql`
          UPDATE widget_keys SET secret_key_last4 = 'XXXX'
          WHERE secret_key_hash = ${sha(key)}
          RETURNING id
        `)),
        ];
      })
      .catch((error: unknown) => (error as { cause?: { code?: string } }).cause?.code);

    // 42501: the row the update would write fails WITH CHECK.
    expect(updated).toBe('42501');
  });

  it('refuses to open inside withTenant', async () => {
    /* ADR 0022's reason: with both set, the key policy's branches are OR-ed. */
    const { tenantId, key } = await winery();

    await expect(
      withTenant(tenantId, () => resolveTenantBySecretKey(sha(key), db), seedDb),
    ).rejects.toBeInstanceOf(NestedSecretKeyContextError);
  });

  it('refuses two active rows sharing a hash, rather than choosing one', async () => {
    /*
     * The partial unique index (0048). 256-bit keys never collide by chance;
     * this catches the bug that would make them, which would otherwise
     * authenticate a key as whichever tenant `LIMIT 1` happened to return.
     */
    const { key } = await winery();
    const other = await createScopedTenant(seedDb, `secret-dup-${suffix()}`);

    const code = await withTenant(
      other,
      (tx) => insertKeys(tx, { publicKey: pk(), ...secretColumns(key) }),
      seedDb,
    ).then(
      () => 'inserted',
      (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
    );

    expect(code).toBe('23505');
  });

  it('lets a revoked row keep the hash its successor now carries', async () => {
    /* The index is partial for exactly this: rotation (P4-08) needs two rows
     * with one hash, one of them revoked. */
    const { tenantId } = await winery();

    await expect(
      withTenant(tenantId, (tx) => rotatePublicKey(tx, pk()), seedDb),
    ).resolves.toBeDefined();
  });
});
