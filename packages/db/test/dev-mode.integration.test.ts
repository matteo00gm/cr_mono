import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { enableDevMode, endDevMode, readDevMode } from '../src/dev-mode.js';
import { resolveTenantByKeyAndOrigin } from '../src/widget-resolution.js';
import { withTenant } from '../src/with-tenant.js';
import { WIDGET_KEY_GUC, WIDGET_ORIGIN_GUC } from '../src/with-widget-key.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Development mode, against real Postgres (P4-19b).
 *
 * **The expiry is the property**, and it is asserted rather than the grant
 * alone: a winery's one local origin resolves while the grant is live, and the
 * same request, a moment after `dev_mode_expires_at`, is refused exactly as a
 * stranger's would be — by the tenants policy, whatever the code believes.
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

const LOCAL = 'http://localhost:3000';

/** Built at runtime, never written as a literal (P0-56). */
const publicKey = (): string => ['pk', 'live', randomBytes(12).toString('hex')].join('_');

const winery = async (): Promise<{ tenantId: string; key: string }> => {
  const tenantId = randomUUID();
  const key = publicKey();

  await adminDb.execute(sql`
    INSERT INTO tenants (id, name, slug, status, stripe_subscription_id) VALUES (${tenantId}::uuid, 'Cantina', ${`dev-${tenantId}`}, 'ACTIVE', 'sub_' || gen_random_uuid())
  `);
  await adminDb.execute(sql`
    INSERT INTO widget_keys (tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4)
    VALUES (${tenantId}::uuid, ${key}, md5(random()::text), 'sk_live', 'abcd')
  `);

  return { tenantId, key };
};

const grant = (tenantId: string, origin = LOCAL) =>
  withTenant(tenantId, (tx) => enableDevMode(tx, origin, 24), db);

describe('a winery in development mode', () => {
  it('is reached from its one local origin, as development', async () => {
    const { tenantId, key } = await winery();
    await grant(tenantId);

    await expect(resolveTenantByKeyAndOrigin(key, LOCAL, db)).resolves.toMatchObject({
      found: true,
      tenantId,
      originKind: 'development',
    });
  });

  it('is not reached once the grant has run out', async () => {
    /* The row's own test: the expiry, not just the grant. */
    const { tenantId, key } = await winery();
    await grant(tenantId);
    await adminDb.execute(sql`
      UPDATE tenants SET dev_mode_expires_at = now() - interval '1 second' WHERE id = ${tenantId}::uuid
    `);

    await expect(resolveTenantByKeyAndOrigin(key, LOCAL, db)).resolves.toEqual({
      found: false,
      reason: 'origin_mismatch',
      tenantId,
    });
    await expect(withTenant(tenantId, readDevMode, db)).resolves.toBeUndefined();
  });

  it('is not reached from any other local origin', async () => {
    /* Exact-set equality (§3.4): one origin, never a port wildcard. */
    const { tenantId, key } = await winery();
    await grant(tenantId);

    await expect(
      resolveTenantByKeyAndOrigin(key, 'http://localhost:4000', db),
    ).resolves.toMatchObject({ found: false, reason: 'origin_mismatch' });
  });

  it('is not reached with another winery’s key', async () => {
    const { tenantId } = await winery();
    const other = await winery();
    await grant(tenantId);

    await expect(resolveTenantByKeyAndOrigin(other.key, LOCAL, db)).resolves.toEqual({
      found: false,
      reason: 'origin_mismatch',
      tenantId: other.tenantId,
    });
  });

  it('ends when it is ended, and says for which origin', async () => {
    const { tenantId, key } = await winery();
    await grant(tenantId);

    await expect(withTenant(tenantId, endDevMode, db)).resolves.toBe(LOCAL);
    await expect(resolveTenantByKeyAndOrigin(key, LOCAL, db)).resolves.toMatchObject({
      found: false,
    });
  });

  it('holds only a local address, and never half a grant', async () => {
    const { tenantId } = await winery();

    const publicOrigin = await grant(tenantId, 'https://winery.com').catch(
      (caught: unknown) => caught,
    );
    const half = await adminDb
      .execute(sql`UPDATE tenants SET dev_origin = ${LOCAL} WHERE id = ${tenantId}::uuid`)
      .catch((caught: unknown) => caught);

    expect((publicOrigin as { cause?: { code?: string } }).cause?.code).toBe('23514');
    expect((half as { cause?: { code?: string } }).cause?.code).toBe('23514');
  });
});

describe('the policy on its own (P4-19b)', () => {
  /*
   * **The resolution's join repeats the policy's conditions**, so every case
   * above passes through both — and would go on passing with the policy's half
   * deleted. These read `tenants` directly under the widget scope's two GUCs,
   * with no join to lean on, so what they see is what the policy admits.
   */
  const visible = (key: string, origin: string): Promise<string[]> =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config(${WIDGET_KEY_GUC}, ${key}, true), set_config(${WIDGET_ORIGIN_GUC}, ${origin}, true)`,
      );

      return [...(await tx.execute(sql`SELECT id FROM tenants`))].map(
        (row) => (row as { id: string }).id,
      );
    });

  it('admits the winery from its dev origin, for its own key, while live', async () => {
    const { tenantId, key } = await winery();
    await grant(tenantId);

    expect(await visible(key, LOCAL)).toEqual([tenantId]);
  });

  it('admits nothing once the grant has run out', async () => {
    const { tenantId, key } = await winery();
    await grant(tenantId);
    await adminDb.execute(sql`
      UPDATE tenants SET dev_mode_expires_at = now() - interval '1 second' WHERE id = ${tenantId}::uuid
    `);

    expect(await visible(key, LOCAL)).toEqual([]);
  });

  it('admits nothing for another winery’s key', async () => {
    const { tenantId } = await winery();
    const other = await winery();
    await grant(tenantId);

    expect(await visible(other.key, LOCAL)).not.toContain(tenantId);
  });
});
