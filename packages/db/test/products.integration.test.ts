import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import { createTenant as createScopedTenant, useTenant } from './support/tenant.js';
import { timestampMicros } from './support/timestamps.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `products` against real Postgres (P0-26).
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';
/** numeric_value_out_of_range — what the column type raises, before any CHECK. */
const NUMERIC_OUT_OF_RANGE = '22003';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

/**
 * Creates a tenant and leaves the session scoped to it (P0-37).
 *
 * Delegates rather than inserting directly: `tenants` now carries
 * `WITH CHECK (id = app.tenant_id)`, so the id has to exist before the row
 * does. Creating a second tenant therefore *moves* the context — tests that
 * span two tenants have to say which one they mean, with `useTenant`.
 */
const createTenant = (slug: string): Promise<string> => createScopedTenant(db, slug);

/** The minimum §2.2 marks as required: name, sku, wine_type, price, stock. */
const insertMinimal = (tenant: string, sku: string) =>
  db.execute(sql`
    insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
    values (${tenant}::uuid, ${sku}, 'Barolo DOCG', 'RED', 3500, 'EUR', 'IN_STOCK')
    returning id, status, embedding_state, content_hash
  `);

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
  tenantId = await createTenant('catalogo');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

/**
 * Re-scope before every test (P0-37).
 *
 * The tenant GUC is session state, so any test that creates a second tenant
 * moves the context and leaves the next one reading as somebody else. Setting
 * it here makes each test independent of what ran before it, which is what the
 * shared `tenantId` from `beforeAll` already implied.
 */
beforeEach(async () => {
  await useTenant(db, tenantId);
});

describe('products', () => {
  it('accepts a row with only the required fields', async () => {
    const rows = await insertMinimal(tenantId, 'SKU-MIN-1');

    expect([...rows][0]).toMatchObject({
      status: 'ACTIVE',
      // PENDING, not INDEXED: a product claiming to be indexed before the
      // worker has seen it is one that silently never gets embedded.
      embedding_state: 'PENDING',
      content_hash: null,
    });
  });

  it.each([
    [
      'name',
      "insert into products (tenant_id, sku, wine_type, price_cents, currency, stock_status) values ($1, 'S1', 'RED', 100, 'EUR', 'IN_STOCK')",
    ],
    [
      'price_cents',
      "insert into products (tenant_id, sku, name, wine_type, currency, stock_status) values ($1, 'S2', 'X', 'RED', 'EUR', 'IN_STOCK')",
    ],
    [
      'stock_status',
      "insert into products (tenant_id, sku, name, wine_type, price_cents, currency) values ($1, 'S3', 'X', 'RED', 100, 'EUR')",
    ],
  ])('requires %s', async (_column, statement) => {
    const error = await db
      .execute(sql.raw(statement.replace('$1', `'${tenantId}'::uuid`)))
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(NOT_NULL_VIOLATION);
  });

  it('rejects a duplicate sku within a tenant', async () => {
    // The upsert key for P1-24: a re-import matches on it and must not be able
    // to create a second row for the same product.
    await insertMinimal(tenantId, 'SKU-DUP');

    const error = await insertMinimal(tenantId, 'SKU-DUP').catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('allows the same sku in a different tenant', async () => {
    // SKUs are the seller's namespace, not ours. Two wineries both using
    // "BAROLO-2019" is ordinary.
    // Each write happens under its own tenant's context, because that is the
    // only way either is permitted now: WITH CHECK rejects a row whose
    // tenant_id is not the one the session is scoped to. Creating the second
    // tenant moves the context, so the first insert comes first.
    await insertMinimal(tenantId, 'BAROLO-2019');

    const other = await createTenant('altra-cantina');

    await expect(insertMinimal(other, 'BAROLO-2019')).resolves.toBeDefined();
  });

  it('round-trips arrays as arrays', async () => {
    // Including a value containing a comma, which is what a delimited-string
    // implementation gets wrong and an array does not.
    //
    // Built with `array[...]` rather than by interpolating a JS array: drizzle
    // expands `${[a, b]}` into a row constructor `($1, $2)`, so the insert is
    // rejected as "expression is of type record" (42804) before the comma is
    // tested at all.
    await db.execute(sql`
      insert into products (
        tenant_id, sku, name, wine_type, price_cents, currency, stock_status,
        grape_varieties, food_pairings, style_tags
      )
      values (
        ${tenantId}::uuid, 'SKU-ARRAY', 'Barbaresco', 'RED', 4200, 'EUR', 'IN_STOCK',
        array[${'Nebbiolo'}]::text[],
        array[${'Brasato al Barolo, ossobuco'}, ${'Formaggi stagionati'}]::text[],
        array[${'strutturato'}]::text[]
      )
    `);

    const rows = await db.execute(
      sql`select grape_varieties, food_pairings from products where sku = 'SKU-ARRAY'`,
    );
    const row = [...rows][0];

    expect(row?.grape_varieties).toEqual(['Nebbiolo']);
    expect(row?.food_pairings).toEqual(['Brasato al Barolo, ossobuco', 'Formaggi stagionati']);
  });

  it('keeps a price exact rather than approximate', async () => {
    // 12.49 stored as minor units comes back as 1249, not 1248.9999.
    await db.execute(sql`
      insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status, alcohol_pct)
      values (${tenantId}::uuid, 'SKU-MONEY', 'Vino', 'WHITE', 1249, 'EUR', 'IN_STOCK', 13.5)
    `);

    const rows = await db.execute(
      sql`select price_cents, alcohol_pct from products where sku = 'SKU-MONEY'`,
    );

    expect([...rows][0]?.price_cents).toBe(1249);
    expect(String([...rows][0]?.alcohol_pct)).toBe('13.50');
  });

  it.each([
    ['a negative price', 'price_cents', '-1'],
    ['a negative stock quantity', 'stock_qty', '-5'],
    ['a negative alcohol percentage', 'alcohol_pct', '-1'],
  ])('refuses %s', async (_label, column, value) => {
    // All three are import failures rather than user intent: a mis-parsed cell,
    // a European decimal comma read as a thousands separator.
    // price_cents carries a valid value so the other two cases have one, and
    // is overwritten when it is itself the column under test. Appending
    // `${column}` to a fixed list that already named price_cents listed it
    // twice, so that case failed with duplicate_column (42701) before the
    // CHECK was ever reached — the assertion was judging the wrong error.
    const values: Record<string, string> = { price_cents: '100', [column]: value };
    const columns = Object.keys(values).join(', ');
    const literals = Object.values(values).join(', ');

    const error = await db
      .execute(
        sql.raw(`
          insert into products (tenant_id, sku, name, wine_type, currency, stock_status, ${columns})
          values ('${tenantId}'::uuid, 'SKU-BAD-${column}', 'X', 'RED', 'EUR', 'IN_STOCK', ${literals})
        `),
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses an impossible alcohol percentage through the column type', async () => {
    // Not a CHECK: numeric(4, 2) cannot represent 120 at all, so the type
    // rejects it first with numeric_value_out_of_range. Worth pinning, because
    // the obvious "between 0 and 100" check would be unreachable code that
    // reads as though it were doing the work.
    const error = await db
      .execute(
        sql.raw(`
          insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status, alcohol_pct)
          values ('${tenantId}'::uuid, 'SKU-ABV-120', 'X', 'RED', 100, 'EUR', 'IN_STOCK', 120)
        `),
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(NUMERIC_OUT_OF_RANGE);
  });

  it('archives rather than deletes', async () => {
    // Soft delete: the row stops being recommended and its history survives.
    // The vectors are hard-deleted separately (§4.3, P1-04).
    await insertMinimal(tenantId, 'SKU-ARCHIVE');
    await db.execute(
      sql`update products set status = 'ARCHIVED'::product_status where sku = 'SKU-ARCHIVE'`,
    );

    const rows = await db.execute(sql`select status from products where sku = 'SKU-ARCHIVE'`);
    expect([...rows][0]?.status).toBe('ARCHIVED');
  });

  it('deletes products when the tenant is deleted', async () => {
    const doomed = await createTenant('catalogo-doomed');
    await insertMinimal(doomed, 'SKU-CASCADE');

    await db.execute(sql`delete from tenants where id = ${doomed}::uuid`);

    const rows = await db.execute(sql`select 1 from products where tenant_id = ${doomed}::uuid`);
    expect([...rows]).toHaveLength(0);
  });

  it('stamps updated_at on update', async () => {
    const inserted = await insertMinimal(tenantId, 'SKU-TOUCH');
    const id = [...inserted][0]?.id;

    const before = await db.execute(sql`select updated_at from products where id = ${id}::uuid`);
    await db.execute(sql`update products set stock_qty = 12 where id = ${id}::uuid`);
    const after = await db.execute(sql`select updated_at from products where id = ${id}::uuid`);

    expect(timestampMicros([...after][0]?.updated_at)).toBeGreaterThan(
      timestampMicros([...before][0]?.updated_at),
    );
  });
});
