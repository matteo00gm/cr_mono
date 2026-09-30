import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { insertDomain, provesZone } from '../src/domains-write.js';
import { resolveTenantByKeyAndOrigin } from '../src/widget-resolution.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Staging origins and zone cover, against real Postgres (P4-19).
 *
 * The caps are counted under the winery's lock and the kind is read back by the
 * widget's own resolution, so both are proved where they actually happen.
 * Seeding goes through the superuser; everything under test through `app_rw`
 * with no session GUC.
 */

let container: StartedPostgreSqlContainer | undefined;
let clients: DbClient[] = [];
let db: Database;
let adminDb: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  const runtime = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  const admin = createDbClient(started.adminUrl, { max: 1 });

  clients = [runtime, admin];
  db = runtime.db;
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await container?.stop();
}, 60_000);

const winery = async (): Promise<string> => {
  const id = randomUUID();

  await adminDb.execute(sql`
    INSERT INTO tenants (id, name, slug, status, stripe_subscription_id) VALUES (${id}::uuid, 'Cantina', ${`kind-${id}`}, 'ACTIVE', 'sub_' || gen_random_uuid())
  `);

  return id;
};

const zone = (): string => `w${randomBytes(4).toString('hex')}.example`;

const hold = async (
  tenantId: string,
  origin: string,
  registrable: string,
  seed: { status?: string; method?: string | null; kind?: string } = {},
): Promise<void> => {
  await adminDb.execute(sql`
    INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status, verification_method, kind)
    VALUES (
      ${tenantId}::uuid, ${origin}, ${registrable},
      ${seed.status ?? 'VERIFIED'}::domain_status,
      ${seed.method === undefined ? 'DNS_TXT' : seed.method}::domain_verification_method,
      ${seed.kind ?? 'production'}::domain_kind
    )
  `);
};

const add = (
  tenantId: string,
  origin: string,
  registrable: string,
  cap: number,
  extra: Partial<Parameters<typeof insertDomain>[1]> = {},
) =>
  withTenant(
    tenantId,
    (tx) =>
      insertDomain(
        tx,
        { origin, registrableDomain: registrable, verificationToken: 'a-nonce', ...extra },
        cap,
      ),
    db,
  );

describe('a staging origin', () => {
  it('is added whatever the plan cap, because it does not count against it', async () => {
    const tenant = await winery();
    const held = zone();
    await hold(tenant, `https://${held}`, held);

    const staging = zone();

    await expect(
      add(tenant, `https://${staging}`, staging, 2, { kind: 'staging' }),
    ).resolves.toMatchObject({ outcome: 'created', domain: { kind: 'staging' } });

    /* And the production cap is still full: staging took no slot from it. */
    const another = zone();

    await expect(add(tenant, `https://${another}`, another, 1)).resolves.toEqual({
      outcome: 'at-cap',
      held: 1,
    });
  });

  it('has a cap of its own, counted in origins', async () => {
    const tenant = await winery();
    const staging = zone();
    await hold(tenant, `https://a.${staging}`, staging, { kind: 'staging' });
    await hold(tenant, `https://b.${staging}`, staging, { kind: 'staging' });

    await expect(
      add(tenant, `https://c.${staging}`, staging, 2, { kind: 'staging' }),
    ).resolves.toEqual({ outcome: 'at-cap', held: 2 });
  });

  it('is told to the widget as staging, for its lower rate limit', async () => {
    const tenant = await winery();
    const staging = zone();
    const key = ['pk', 'live', randomBytes(12).toString('hex')].join('_');
    await hold(tenant, `https://${staging}`, staging, { kind: 'staging' });
    await adminDb.execute(sql`
      INSERT INTO widget_keys (tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4)
      VALUES (${tenant}::uuid, ${key}, md5(random()::text), 'sk_live', 'abcd')
    `);

    await expect(resolveTenantByKeyAndOrigin(key, `https://${staging}`, db)).resolves.toMatchObject(
      { found: true, originKind: 'staging' },
    );
  });
});

describe('a zone already proved', () => {
  it('covers a new origin under it when the proof was DNS', async () => {
    const tenant = await winery();
    const registrable = zone();
    await hold(tenant, `https://${registrable}`, registrable, { method: 'DNS_TXT' });

    await expect(withTenant(tenant, (tx) => provesZone(tx, registrable), db)).resolves.toBe(true);

    const covered = await add(tenant, `https://shop.${registrable}`, registrable, 1, {
      coveredBy: 'DNS_TXT',
    });

    expect(covered).toMatchObject({
      outcome: 'created',
      domain: { status: 'VERIFIED', verificationToken: null, verificationExpiresAt: null },
    });
  });

  it('does not cover anything when the proof was a file on one host', async () => {
    /* A subdomain may point at somebody else's server entirely. */
    const tenant = await winery();
    const registrable = zone();
    await hold(tenant, `https://${registrable}`, registrable, { method: 'WELL_KNOWN' });

    await expect(withTenant(tenant, (tx) => provesZone(tx, registrable), db)).resolves.toBe(false);
  });

  it('does not count a pending row, or another winery’s proof', async () => {
    const [tenant, other] = [await winery(), await winery()];
    const registrable = zone();
    await hold(tenant, `https://${registrable}`, registrable, { status: 'PENDING', method: null });
    await hold(other, `https://www.${registrable}`, registrable);

    await expect(withTenant(tenant, (tx) => provesZone(tx, registrable), db)).resolves.toBe(false);
  });

  it('costs no plan slot for a production origin under a registrable domain already held', async () => {
    const tenant = await winery();
    const registrable = zone();
    await hold(tenant, `https://${registrable}`, registrable);

    await expect(add(tenant, `https://shop.${registrable}`, registrable, 1)).resolves.toMatchObject(
      { outcome: 'created' },
    );
  });
});
