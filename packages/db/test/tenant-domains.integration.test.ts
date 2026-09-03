import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import { createTenant as createScopedTenant, useTenant } from './support/tenant.js';
import { timestampMicros } from './support/timestamps.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `tenant_domains` against real Postgres (P0-24).
 *
 * Two properties carry the whole anti-widget-sharing design, and both are
 * database constraints rather than application rules, so both are asserted
 * against a real server: an origin belongs to exactly one tenant, and a
 * malformed origin cannot reach the allowlist at all.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

const UNIQUE_VIOLATION = '23505';
/** check_violation. */
const CHECK_VIOLATION = '23514';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantA: string;
let tenantB: string;

/**
 * Creates a tenant and leaves the session scoped to it (P0-37).
 *
 * Delegates rather than inserting directly: `tenants` now carries
 * `WITH CHECK (id = app.tenant_id)`, so the id has to exist before the row
 * does. Creating a second tenant therefore *moves* the context — tests that
 * span two tenants have to say which one they mean, with `useTenant`.
 */
const createTenant = (slug: string): Promise<string> => createScopedTenant(db, slug);

const addDomain = (tenantId: string, origin: string, registrable = 'winery.com') =>
  db.execute(sql`
    insert into tenant_domains (tenant_id, origin, registrable_domain)
    values (${tenantId}::uuid, ${origin}, ${registrable})
    returning id, status, verified_at
  `);

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  tenantA = await createTenant('tenant-a');
  tenantB = await createTenant('tenant-b');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

/**
 * Re-scope to tenant A before every test (P0-37).
 *
 * `beforeAll` creates two tenants and the second one leaves the session scoped
 * to it, so without this every test asserting on A reads as B. Tests that mean
 * B say so with `useTenant`.
 */
beforeEach(async () => {
  await useTenant(db, tenantA);
});

describe('tenant_domains', () => {
  it('starts a domain unverified', async () => {
    // A domain that is serviceable the moment it is typed in is a widget
    // anyone can install on any site by claiming it.
    const rows = await addDomain(tenantA, 'https://verified-later.com');

    expect([...rows][0]).toMatchObject({ status: 'PENDING', verified_at: null });
  });

  it('lets exactly one tenant hold an origin', async () => {
    // §3.2, the whole point of the table. Global, not per tenant: two tenants
    // claiming https://winery.com is the sharing this design exists to stop.
    await addDomain(tenantA, 'https://winery.com');

    // Each write under its own tenant's context. The unique index still spans
    // both, which is the point: B cannot see A's claim and is refused anyway.
    await useTenant(db, tenantB);
    const error = await addDomain(tenantB, 'https://winery.com').catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('holds the origin even while the first claim is unverified', async () => {
    // Deliberate. Scoping uniqueness to verified rows would let two tenants
    // hold competing claims and race at verification, which turns a failed
    // insert into someone losing a domain they already built against.
    await addDomain(tenantA, 'https://unverified-claim.com');

    // As above: the second claim is made under B's own context.
    await useTenant(db, tenantB);
    const error = await addDomain(tenantB, 'https://unverified-claim.com').catch(
      (caught: unknown) => caught,
    );

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it.each([
    ['uppercase scheme and host', 'HTTPS://WINERY.COM'],
    ['mixed case host', 'https://Winery.com'],
    ['trailing slash', 'https://winery.com/'],
    ['a path', 'https://winery.com/shop'],
    ['a trailing dot', 'https://winery.com.'],
    ['an empty label', 'https://winery..com'],
    ['a bare hostname', 'winery.com'],
    ['a leading hyphen in a label', 'https://-winery.com'],
    ['a trailing hyphen in a label', 'https://winery-.com'],
    ['a userinfo section', 'https://user@winery.com'],
    ['a wildcard', 'https://*.winery.com'],
    ['whitespace', 'https://winery.com '],
    ['an unsupported scheme', 'ftp://winery.com'],
  ])('refuses an origin with %s', async (_label, origin) => {
    // Every one of these is either the same origin as a legitimate entry after
    // a browser normalises it, or a string no browser will ever send. Both
    // shapes are how an allowlist comparison gets fooled (§6.3). P2-05
    // normalises before the insert; this is what holds if that is bypassed.
    const error = await addDomain(tenantA, origin).catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it.each([
    ['a plain https origin', 'https://cantina-rossi.it'],
    ['a subdomain', 'https://shop.cantina-rossi.it'],
    ['an explicit port', 'https://cantina-rossi.it:8443'],
    ['a local development origin', 'http://localhost:5173'],
  ])('accepts %s', async (_label, origin) => {
    await expect(addDomain(tenantA, origin, 'cantina-rossi.it')).resolves.toBeDefined();
  });

  it('deletes domains when the tenant is deleted', async () => {
    // An origin left behind by a deleted tenant is worse than an orphan: it
    // holds the unique constraint, so the domain can never be claimed again.
    const doomed = await createTenant('doomed');
    await addDomain(doomed, 'https://doomed.example');

    await db.execute(sql`delete from tenants where id = ${doomed}::uuid`);

    const rows = await db.execute(
      sql`select 1 from tenant_domains where origin = 'https://doomed.example'`,
    );
    expect([...rows]).toHaveLength(0);
  });

  it('stamps updated_at on update', async () => {
    const rows = await addDomain(tenantA, 'https://touch-domain.example');
    const id = [...rows][0]?.id;

    const before = await db.execute(
      sql`select updated_at from tenant_domains where id = ${id}::uuid`,
    );
    await db.execute(sql`
      update tenant_domains
      set status = 'VERIFIED'::domain_status, verified_at = now()
      where id = ${id}::uuid
    `);
    const after = await db.execute(
      sql`select updated_at from tenant_domains where id = ${id}::uuid`,
    );

    expect(timestampMicros([...after][0]?.updated_at)).toBeGreaterThan(
      timestampMicros([...before][0]?.updated_at),
    );
  });
});
