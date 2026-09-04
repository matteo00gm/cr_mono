import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { RLS_POLICIES } from '../src/rls.js';
import { startPostgres } from './support/postgres.js';
import { createAuthUser, createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Per-table proof that tenant B cannot reach tenant A's rows (P0-38).
 *
 * P0-37's policy is a claim until this exists. The table list is
 * `RLS_POLICIES` — the same source the migration is generated from — so adding
 * a table adds its test rather than requiring someone to remember. The
 * coverage assertion below is what makes that true rather than aspirational: a
 * table in the list with no seeder here fails, so the two cannot drift apart.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** insufficient_privilege — how a WITH CHECK rejection surfaces. */
const INSUFFICIENT_PRIVILEGE = '42501';

/** Tables where `app_rw` holds no UPDATE, so the update probe cannot apply. */
const APPEND_ONLY = new Set(['usage_events', 'audit_log', 'security_events']);

interface SeedContext {
  readonly conversationId: string;
  readonly productId: string;
  /**
   * A real `auth_users` row (P0-23a). `memberships.user_id` now references it,
   * so an invented id is refused with 23503 — which would make the WITH CHECK
   * assertion below pass for entirely the wrong reason.
   */
  readonly userId: string;
}

/**
 * One row per table, for a given tenant.
 *
 * Used twice: to seed tenant A legitimately, and — with A's id while scoped to
 * B — as the write the policy has to reject.
 */
const INSERTS: Record<string, (tenantId: string, ctx: SeedContext) => SQL> = {
  tenants: (tenantId) =>
    sql`insert into tenants (id, name, slug) values (${tenantId}::uuid, 'x', ${`iso-${tenantId}`})`,
  memberships: (tenantId, ctx) =>
    sql`insert into memberships (tenant_id, user_id, role)
        values (${tenantId}::uuid, ${ctx.userId}, 'EDITOR')`,
  tenant_domains: (tenantId) =>
    sql`insert into tenant_domains (tenant_id, origin, registrable_domain)
        values (${tenantId}::uuid, ${`https://${tenantId.slice(0, 8)}.example`}, 'example.com')`,
  widget_keys: (tenantId) =>
    sql`insert into widget_keys (tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4)
        values (${tenantId}::uuid, ${`pk_${tenantId}`}, 'hash', 'sk_live', 'abcd')`,
  products: (tenantId) =>
    sql`insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
        values (${tenantId}::uuid, ${`sku-${tenantId}`}, 'Barolo', 'RED', 100, 'EUR', 'IN_STOCK')`,
  /*
   * A literal product id rather than `insert ... select ... from products`.
   *
   * The select form cannot test WITH CHECK at all: read from B's seat the
   * subquery is filtered to nothing, so the insert writes zero rows and
   * raises nothing — a silent success that looks exactly like a policy
   * working. That is worth knowing beyond this file: under RLS an
   * `INSERT ... SELECT` degrades to a no-op rather than an error, so any
   * writer built that way fails quietly when its context is wrong.
   */
  product_embeddings: (tenantId, ctx) =>
    sql`insert into product_embeddings (tenant_id, product_id, chunk_idx, content_hash, embedding, model)
        values (${tenantId}::uuid, ${ctx.productId}::uuid, 0, 'h',
                (select '[' || string_agg('0.1', ',') || ']' from generate_series(1, 1024))::halfvec,
                'amazon.titan-embed-text-v2')`,
  conversations: (tenantId) =>
    sql`insert into conversations (tenant_id, session_id, origin, locale)
        values (${tenantId}::uuid, 's', 'https://x.example', 'it')`,
  messages: (tenantId, ctx) =>
    sql`insert into messages (tenant_id, conversation_id, role, content)
        values (${tenantId}::uuid, ${ctx.conversationId}::uuid, 'USER', 'ciao')`,
  widget_events: (tenantId) =>
    sql`insert into widget_events (tenant_id, session_id, type)
        values (${tenantId}::uuid, 's', 'WIDGET_OPEN')`,
  usage_events: (tenantId) =>
    sql`insert into usage_events (tenant_id, period, kind)
        values (${tenantId}::uuid, '202609', 'CHAT')`,
  usage_daily: (tenantId) =>
    sql`insert into usage_daily (tenant_id, day) values (${tenantId}::uuid, '2026-09-01')`,
  audit_log: (tenantId) =>
    sql`insert into audit_log (tenant_id, action) values (${tenantId}::uuid, 'x')`,
  security_events: (tenantId) =>
    sql`insert into security_events (tenant_id, type) values (${tenantId}::uuid, 'RATE_LIMITED')`,
  token_revocations: (tenantId) =>
    sql`insert into token_revocations (jti, tenant_id, expires_at)
        values (${`jti-${tenantId}`}, ${tenantId}::uuid, '2030-01-01T00:00:00Z')`,
  outbox: (tenantId) =>
    sql`insert into outbox (tenant_id, aggregate_id, event_type)
        values (${tenantId}::uuid, gen_random_uuid(), 'e')`,
};

/** `tenants` is scoped by its own id; everything else by `tenant_id`. */
const scopeColumn = (table: string): string => (table === 'tenants' ? 'id' : 'tenant_id');

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantA: string;
let tenantB: string;
let seedContext: SeedContext;

const countFor = async (table: string, tenantId: string): Promise<number> => {
  const rows = await db.execute(
    sql`select count(*)::int as n from ${sql.raw(table)}
        where ${sql.raw(scopeColumn(table))} = ${tenantId}::uuid`,
  );

  return Number([...rows][0]?.n);
};

const insertFor = (table: string, tenantId: string): SQL => {
  const build = INSERTS[table];

  if (!build) {
    throw new Error(`no seeder for ${table} — RLS_POLICIES and this file have drifted`);
  }

  return build(tenantId, seedContext);
};

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  tenantA = await createTenant(db, 'iso-a');

  // Seeded in RLS_POLICIES order, which is also dependency order: a
  // conversation exists before the message referencing it, a product before
  // its embedding.
  const conversation = await db.execute(sql`
    insert into conversations (tenant_id, session_id, origin, locale)
    values (${tenantA}::uuid, 'seed', 'https://a.example', 'it')
    returning id
  `);
  const product = await db.execute(sql`
    insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
    values (${tenantA}::uuid, 'seed-sku', 'Barolo', 'RED', 100, 'EUR', 'IN_STOCK')
    returning id
  `);

  // auth_users carries no policy, so this works under any context — the
  // property that makes login possible before a tenant is known.
  const userId = await createAuthUser(db, 'iso');

  seedContext = {
    conversationId: String([...conversation][0]?.id),
    productId: String([...product][0]?.id),
    userId,
  };

  for (const { table } of RLS_POLICIES) {
    if (table === 'tenants') continue;
    await db.execute(insertFor(table, tenantA));
  }

  // Creating B moves the session context to it, which is where these tests
  // want to start: looking at A's data from B's seat.
  tenantB = await createTenant(db, 'iso-b');
}, 240_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

describe('rls isolation', () => {
  it('has a seeder for every table the migration protects', () => {
    // What keeps this file honest as tables are added. Without it a new table
    // joins RLS_POLICIES, gets a policy, and is silently never tested here.
    const covered = new Set(Object.keys(INSERTS));

    expect(RLS_POLICIES.map((policy) => policy.table).filter((t) => !covered.has(t))).toEqual([]);
  });

  describe.each(RLS_POLICIES.map((policy) => policy.table))('%s', (table) => {
    it('shows none of the other tenant rows', async () => {
      await useTenant(db, tenantB);

      expect(await countFor(table, tenantA)).toBe(0);
    });

    it('still shows them to the tenant that owns them', async () => {
      // The other half. Without it, a policy hiding everything from everyone
      // would satisfy the assertion above.
      await useTenant(db, tenantA);

      expect(await countFor(table, tenantA)).toBeGreaterThan(0);
    });

    it('refuses a write carrying the other tenant id', async () => {
      // WITH CHECK, not USING. Without it a bug could insert a row belonging
      // to someone else and never notice: reading it back would filter it out,
      // so the write would look like it worked.
      await useTenant(db, tenantB);

      const error = await db.execute(insertFor(table, tenantA)).catch((caught: unknown) => caught);

      expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
    });

    if (!APPEND_ONLY.has(table) && table !== 'tenants') {
      it('updates none of the other tenant rows', async () => {
        await useTenant(db, tenantB);

        await db.execute(
          sql`update ${sql.raw(table)} set ${sql.raw(scopeColumn(table))} = ${tenantB}::uuid
              where ${sql.raw(scopeColumn(table))} = ${tenantA}::uuid`,
        );

        // The update reports success having touched nothing, which is the
        // quiet outcome worth pinning: A's rows are still A's.
        await useTenant(db, tenantA);
        expect(await countFor(table, tenantA)).toBeGreaterThan(0);
      });
    }
  });
});
