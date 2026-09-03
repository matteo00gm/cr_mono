import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import { useTenant } from './support/tenant.js';
import { timestampMicros } from './support/timestamps.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `tenants` against real Postgres (P0-22).
 *
 * The schema spec asserts what the TypeScript declares; this asserts what the
 * migrated database actually enforces. Both are needed: a constraint that
 * exists in the Drizzle model and not in the SQL protects nothing.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** unique_violation. */
const UNIQUE_VIOLATION = '23505';
/** invalid_text_representation — what an unknown enum label raises. */
const INVALID_ENUM = '22P02';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

/**
 * Creates a tenant the way signup has to after P0-37.
 *
 * `tenants` carries `WITH CHECK (id = app.tenant_id)`, so the row must satisfy
 * a policy naming an id that does not exist until this statement runs. The
 * resolution is to generate the id in the application and set the context
 * first — which is what P0-37 specifies signup does, so this helper exercises
 * the real path rather than a test-only escape.
 */
const insert = async (values: { name: string; slug: string; status?: string }) => {
  const id = randomUUID();

  await useTenant(db, id);

  return db.execute(sql`
    insert into tenants (id, name, slug, status)
    values (
      ${id}::uuid,
      ${values.name},
      ${values.slug},
      coalesce(${values.status ?? null}, 'PENDING_VERIFICATION')::tenant_status
    )
    returning id, status, plan, locale, currency
  `);
};

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  // As app_rw, the way the application will reach it — not as the owner, so
  // the DML privileges granted in bootstrap/0001 are exercised rather than
  // assumed.
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

describe('tenants', () => {
  it('inserts with the documented defaults', async () => {
    const rows = await insert({ name: 'Cantina Rossi', slug: 'cantina-rossi' });
    const tenant = [...rows][0];

    expect(tenant).toMatchObject({
      status: 'PENDING_VERIFICATION',
      plan: null,
      locale: 'it',
      currency: 'EUR',
    });
    expect(tenant?.id).toEqual(expect.any(String));
  });

  it('treats slugs as case-insensitive for uniqueness', async () => {
    // The reason slug is citext. With `text` this insert succeeds and the
    // seller ends up with two tenants whose URLs differ only in case.
    await insert({ name: 'Barolo Uno', slug: 'barolo-uno' });

    const error = await insert({ name: 'Barolo Due', slug: 'BAROLO-UNO' }).catch(
      (caught: unknown) => caught,
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('rejects a second tenant claiming the same Stripe customer', async () => {
    // A webhook carrying a customer id has to resolve to exactly one tenant.
    // Without the constraint the handler has to guess which.
    // Both rows need their own id and context, as signup does. The unique
    // index is checked against every row rather than the visible ones, so the
    // violation still fires across a tenant boundary the reader cannot see —
    // which is the property being asserted.
    const first = randomUUID();
    await useTenant(db, first);
    await db.execute(sql`
      insert into tenants (id, name, slug, stripe_customer_id)
      values (${first}::uuid, 'Stripe One', 'stripe-one', 'cus_shared')
    `);

    const second = randomUUID();
    await useTenant(db, second);
    const error = await db
      .execute(
        sql`insert into tenants (id, name, slug, stripe_customer_id)
            values (${second}::uuid, 'Stripe Two', 'stripe-two', 'cus_shared')`,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('rejects a status outside the enum', async () => {
    // Including the ones a future version might add: the type is the guard, so
    // adding a state is a migration rather than a string someone writes.
    const error = await insert({
      name: 'Bad Status',
      slug: 'bad-status',
      status: 'SUSPENDED',
    }).catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INVALID_ENUM);
  });

  it('stamps updated_at in the database, including on a raw update', async () => {
    // Deliberately a plain SQL update rather than one issued through Drizzle:
    // that is the path an application-level `$onUpdate` would miss, and the
    // reason this is a trigger.
    const inserted = await insert({ name: 'Touch Me', slug: 'touch-me' });
    const id = [...inserted][0]?.id;

    const before = await db.execute(sql`select updated_at from tenants where id = ${id}::uuid`);
    await db.execute(sql`update tenants set name = 'Touched' where id = ${id}::uuid`);
    const after = await db.execute(sql`select updated_at from tenants where id = ${id}::uuid`);

    expect(timestampMicros([...after][0]?.updated_at)).toBeGreaterThan(
      timestampMicros([...before][0]?.updated_at),
    );
  });

  it('is owned by app_migrate, not by the role the application connects as', async () => {
    // FORCE ROW LEVEL SECURITY does not apply to a table's owner. If app_rw
    // ever owns a table, every policy on it is silently inert — so ownership is
    // asserted here rather than assumed from the migration having run.
    const rows = await db.execute(
      sql`select tableowner from pg_tables where tablename = 'tenants'`,
    );

    expect([...rows][0]?.tableowner).toBe('app_migrate');
  });
});
