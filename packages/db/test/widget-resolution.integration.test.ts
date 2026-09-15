import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { resolveTenantByKeyAndOrigin } from '../src/widget-resolution.js';
import { withTenant } from '../src/with-tenant.js';
import { withWidgetKey } from '../src/with-widget-key.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The allowlist accessor and its scope against real Postgres (P2-07, ADR 0022).
 *
 * Three properties can only be asserted here:
 *
 * 1. **The row's outcomes**, through the real policies: a correct pair
 *    resolves; a valid key from the wrong origin is a mismatch; an unknown key
 *    is unknown; a revoked key fails outside its grace window and works inside
 *    it; an unverified domain fails.
 * 2. **The scope admits exactly what ADR 0022 says**: one key row, that key's
 *    tenant's matching domain, and the tenant row only behind a verified
 *    domain — and nothing from any other tenant.
 * 3. **It cannot write.** Every INSERT, UPDATE and DELETE inside it fails,
 *    whatever a policy admits.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/** Assembled at runtime, never written as a literal (P0-56). */
const publicKey = (): string => ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

const KEY_A = publicKey();
const KEY_A_IN_GRACE = publicKey();
const KEY_A_EXPIRED = publicKey();
const KEY_B = publicKey();

const ORIGIN_A = 'https://cantina-rossi.example';
const ORIGIN_A_PENDING = 'https://shop.cantina-rossi.example';
const ORIGIN_B = 'https://cantina-verdi.example';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

const seedTenant = async (
  id: string,
  slug: string,
  keys: readonly { key: string; revoked?: 'in-grace' | 'expired' }[],
  domains: readonly { origin: string; registrable: string; status: 'VERIFIED' | 'PENDING' }[],
): Promise<void> => {
  await withTenant(
    id,
    async (tx) => {
      await tx.execute(sql`
        INSERT INTO tenants (id, name, slug, status, plan, locale)
        VALUES (${id}::uuid, ${slug}, ${slug}, 'ACTIVE', 'CANTINA', 'it')
      `);

      for (const { key, revoked } of keys) {
        const revokedAt = revoked === undefined ? null : sql`now() - interval '2 days'`;
        const graceUntil =
          revoked === 'in-grace'
            ? sql`now() + interval '1 day'`
            : revoked === 'expired'
              ? sql`now() - interval '1 day'`
              : null;

        await tx.execute(sql`
          INSERT INTO widget_keys
            (tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4, revoked_at, grace_until)
          VALUES (${id}::uuid, ${key}, 'argon2id-placeholder', 'sk_test_', 'abcd', ${revokedAt}, ${graceUntil})
        `);
      }

      for (const { origin, registrable, status } of domains) {
        await tx.execute(sql`
          INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status)
          VALUES (${id}::uuid, ${origin}, ${registrable}, ${status}::domain_status)
        `);
      }
    },
    db,
  );
};

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  // One connection, so the leak assertion reads the connection the scope used.
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  await seedTenant(
    A,
    'cantina-rossi',
    [
      { key: KEY_A },
      { key: KEY_A_IN_GRACE, revoked: 'in-grace' },
      { key: KEY_A_EXPIRED, revoked: 'expired' },
    ],
    [
      { origin: ORIGIN_A, registrable: 'cantina-rossi.example', status: 'VERIFIED' },
      { origin: ORIGIN_A_PENDING, registrable: 'cantina-rossi.example', status: 'PENDING' },
    ],
  );
  await seedTenant(
    B,
    'cantina-verdi',
    [{ key: KEY_B }],
    [{ origin: ORIGIN_B, registrable: 'cantina-verdi.example', status: 'VERIFIED' }],
  );
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

describe('the outcomes the row lists', () => {
  it('resolves a correct pair to its tenant', async () => {
    await expect(resolveTenantByKeyAndOrigin(KEY_A, ORIGIN_A, db)).resolves.toEqual({
      found: true,
      tenantId: A,
      status: 'ACTIVE',
      plan: 'CANTINA',
      locale: 'it',
    });
  });

  it("reports a valid key from another tenant's verified origin as a mismatch", async () => {
    // Tenant B's origin is verified — by B. It must not resolve A's key, and
    // the tenant reported for the log is the key's, never the origin's.
    await expect(resolveTenantByKeyAndOrigin(KEY_A, ORIGIN_B, db)).resolves.toEqual({
      found: false,
      reason: 'origin_mismatch',
      tenantId: A,
    });
  });

  it('reports a valid key from an origin nobody verified as a mismatch', async () => {
    await expect(
      resolveTenantByKeyAndOrigin(KEY_A, 'https://evil-cantina-rossi.example', db),
    ).resolves.toMatchObject({ found: false, reason: 'origin_mismatch' });
  });

  it('reports an unknown key as unknown', async () => {
    await expect(resolveTenantByKeyAndOrigin(publicKey(), ORIGIN_A, db)).resolves.toEqual({
      found: false,
      reason: 'unknown_key',
    });
  });

  it('refuses a revoked key outside its grace window', async () => {
    await expect(resolveTenantByKeyAndOrigin(KEY_A_EXPIRED, ORIGIN_A, db)).resolves.toEqual({
      found: false,
      reason: 'unknown_key',
    });
  });

  it('accepts a revoked key inside its grace window', async () => {
    await expect(resolveTenantByKeyAndOrigin(KEY_A_IN_GRACE, ORIGIN_A, db)).resolves.toMatchObject({
      found: true,
      tenantId: A,
    });
  });

  it('refuses a domain that is still pending verification', async () => {
    await expect(resolveTenantByKeyAndOrigin(KEY_A, ORIGIN_A_PENDING, db)).resolves.toEqual({
      found: false,
      reason: 'origin_mismatch',
      tenantId: A,
    });
  });
});

const count = async (tx: Parameters<Parameters<typeof withWidgetKey>[2]>[0], table: string) => {
  const rows = await tx.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
  return Number(([...rows][0] as { n: number | string }).n);
};

describe('what the scope admits (ADR 0022)', () => {
  it('sees one key, its matching domain and its tenant — and nothing of anyone else', async () => {
    const seen = await withWidgetKey(
      KEY_A,
      ORIGIN_A,
      async (tx) => ({
        keys: await count(tx, 'widget_keys'),
        domains: await count(tx, 'tenant_domains'),
        tenants: await count(tx, 'tenants'),
        memberships: await count(tx, 'memberships'),
      }),
      db,
    );

    // Not A's other keys, not A's pending domain, not B at all.
    expect(seen).toEqual({ keys: 1, domains: 1, tenants: 1, memberships: 0 });
  });

  it('reaches no tenant row from a key alone', async () => {
    const seen = await withWidgetKey(
      KEY_A,
      'https://nobody.example',
      async (tx) => ({
        keys: await count(tx, 'widget_keys'),
        domains: await count(tx, 'tenant_domains'),
        tenants: await count(tx, 'tenants'),
      }),
      db,
    );

    expect(seen).toEqual({ keys: 1, domains: 0, tenants: 0 });
  });

  it('reaches no tenant row behind a pending domain', async () => {
    const tenants = await withWidgetKey(KEY_A, ORIGIN_A_PENDING, (tx) => count(tx, 'tenants'), db);

    expect(tenants).toBe(0);
  });

  it("does not show another tenant's verified domain to a key it did not issue", async () => {
    const seen = await withWidgetKey(
      KEY_A,
      ORIGIN_B,
      async (tx) => ({
        domains: await count(tx, 'tenant_domains'),
        tenants: await count(tx, 'tenants'),
      }),
      db,
    );

    expect(seen).toEqual({ domains: 0, tenants: 0 });
  });

  it('sees nothing at all with an origin and an unknown key', async () => {
    const seen = await withWidgetKey(
      publicKey(),
      ORIGIN_A,
      async (tx) => ({
        keys: await count(tx, 'widget_keys'),
        domains: await count(tx, 'tenant_domains'),
        tenants: await count(tx, 'tenants'),
      }),
      db,
    );

    expect(seen).toEqual({ keys: 0, domains: 0, tenants: 0 });
  });

  it('leaves ordinary tenant reads exactly as they were', async () => {
    const seen = await withTenant(
      B,
      async (tx) => ({
        keys: await count(tx, 'widget_keys'),
        domains: await count(tx, 'tenant_domains'),
        tenants: await count(tx, 'tenants'),
      }),
      db,
    );

    expect(seen).toEqual({ keys: 1, domains: 1, tenants: 1 });
  });

  it('leaves nothing set on the connection afterwards', async () => {
    await withWidgetKey(KEY_A, ORIGIN_A, (tx) => count(tx, 'widget_keys'), db);

    const rows = await db.execute(
      sql`SELECT current_setting('app.widget_key', true) AS key, current_setting('app.widget_origin', true) AS origin`,
    );
    const settings = [...rows][0] as { key: string | null; origin: string | null };

    expect(settings.key ?? '').toBe('');
    expect(settings.origin ?? '').toBe('');
  });
});

describe('what the scope cannot do (ADR 0022)', () => {
  const refusedInScope = (statement: ReturnType<typeof sql>) =>
    withWidgetKey(KEY_A, ORIGIN_A, (tx) => tx.execute(statement), db).then(
      () => 'written',
      (error: unknown) => String((error as { cause?: unknown }).cause ?? error),
    );

  it.each([
    [
      'insert a domain',
      sql`INSERT INTO tenant_domains (tenant_id, origin, registrable_domain) VALUES (${A}::uuid, 'https://sneaky.example', 'sneaky.example')`,
    ],
    ['update a key', sql`UPDATE widget_keys SET revoked_at = now() WHERE public_key = ${KEY_A}`],
    ['delete a domain', sql`DELETE FROM tenant_domains WHERE origin = ${ORIGIN_A}`],
    ['update a tenant', sql`UPDATE tenants SET status = 'DISABLED'`],
  ])('cannot %s', async (_label, statement) => {
    expect(await refusedInScope(statement)).toMatch(/read-only transaction/);
  });

  it('still has the domain it could not delete', async () => {
    await expect(resolveTenantByKeyAndOrigin(KEY_A, ORIGIN_A, db)).resolves.toMatchObject({
      found: true,
    });
  });
});
