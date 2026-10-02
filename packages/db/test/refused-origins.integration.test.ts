import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { readRefusedOrigins } from '../src/refused-origins.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { clearTenant, createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The sites refused for a winery's key, against real Postgres (P6-05).
 *
 * A week of refusals: one site many times from a few places, one from one,
 * one the winery has since added, refusals of other kinds, a key that matched
 * nobody, the edges of the range — and another winery's refusals.
 */

const START = new Date('2026-09-01T00:00:00.000Z');
const END = new Date('2026-09-08T00:00:00.000Z');
const IN_RANGE = '2026-09-03T12:00:00.000Z';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;
let otherTenantId: string;

/** A refusal recorded as P2-16 records it, under whichever tenant is in scope (or none). */
const refused = (
  origin: string | null,
  bucket: string,
  at = IN_RANGE,
  type = 'UNAUTHORIZED_ORIGIN',
) =>
  db.execute(sql`
    insert into security_events (tenant_id, type, origin, ip_bucket, created_at)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${type}::security_event_type,
            ${origin}, ${bucket}, ${at}::timestamptz)
  `);

const read = (scope = tenantId, start = START, end = END, limit = 50) =>
  withTenant(scope, (tx) => readRefusedOrigins(tx, { start, end, limit }), db);

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  otherTenantId = await createTenant(db, 'altra-origini');
  await refused('https://copia.example', 'b-other');
  await refused('https://shop.cantina.example', 'b-other');
  /* The www this winery adds below: refused for the other's key too, and not the other's domain. */
  await refused('https://www.cantina.example', 'b-other');

  tenantId = await createTenant(db, 'origini');

  /* The new shop: many attempts, from three places. */
  for (const bucket of ['b1', 'b1', 'b2', 'b3', 'b3'])
    await refused('https://shop.cantina.example', bucket);
  /* Somebody's copy, once. */
  await refused('https://copia.example', 'b9', '2026-09-06T10:00:00.000Z');
  /* A www the winery has since added and not yet verified. */
  await refused('https://www.cantina.example', 'b4');
  await db.execute(sql`
    insert into tenant_domains (tenant_id, origin, registrable_domain, status)
    values (${tenantId}::uuid, 'https://www.cantina.example', 'cantina.example', 'PENDING')
  `);
  /* A sandboxed frame. */
  await refused('null', 'b5');
  /* Refusals that are not about an origin. */
  await refused('https://shop.cantina.example', 'b6', IN_RANGE, 'RATE_LIMITED');
  await refused('https://shop.cantina.example', 'b6', IN_RANGE, 'INVALID_TOKEN');
  /* The edges: the range is [start, end). */
  await refused('https://primo.example', 'b7', START.toISOString());
  await refused('https://dopo.example', 'b8', END.toISOString());

  /* A key that matched nobody: no tenant, readable by nobody but app_admin. */
  await clearTenant(db);
  await refused('https://shop.cantina.example', 'b-anon', IN_RANGE, 'INVALID_KEY');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await useTenant(db, tenantId);
});

describe('readRefusedOrigins', () => {
  it('groups by site, with the attempts, the distinct places and when last', async () => {
    const [first] = await read();

    expect(first).toEqual({
      origin: 'https://shop.cantina.example',
      attempts: 5,
      sources: 3,
      lastSeenAt: new Date(IN_RANGE),
      domainStatus: null,
    });
  });

  it('counts only refusals for an origin, not rate limits or bad tokens from the same site', async () => {
    const shop = (await read()).find(({ origin }) => origin === 'https://shop.cantina.example');

    expect(shop?.attempts).toBe(5);
  });

  it('says when the winery has added a site since, and how far it got', async () => {
    const www = (await read()).find(({ origin }) => origin === 'https://www.cantina.example');

    expect(www?.domainStatus).toBe('PENDING');
  });

  it('keeps what the browser sent, a sandboxed frame’s `null` included', async () => {
    expect((await read()).map(({ origin }) => origin)).toContain('null');
  });

  it('lists the most attempts first, and no more than asked', async () => {
    expect((await read(tenantId, START, END, 1)).map(({ origin }) => origin)).toEqual([
      'https://shop.cantina.example',
    ]);
  });

  it('counts only [start, end)', async () => {
    const origins = (await read()).map(({ origin }) => origin);

    expect(origins).toContain('https://primo.example');
    expect(origins).not.toContain('https://dopo.example');
  });

  it("is the scope's winery only, and never a refusal that matched no winery", async () => {
    const mine = (await read()).find(({ origin }) => origin === 'https://shop.cantina.example');
    const theirs = await read(otherTenantId);

    /* Five, not six with the other winery's, and not seven with the anonymous INVALID_KEY. */
    expect(mine?.attempts).toBe(5);
    expect(theirs.map(({ origin, attempts }) => [origin, attempts]).sort()).toEqual([
      ['https://copia.example', 1],
      ['https://shop.cantina.example', 1],
      ['https://www.cantina.example', 1],
    ]);
  });

  it("does not see another winery's domain as its own", async () => {
    /* This winery added the www; for the other, under its own policy, it is nobody's. */
    const www = (await read(otherTenantId)).find(
      ({ origin }) => origin === 'https://www.cantina.example',
    );

    expect(www?.domainStatus).toBeNull();
  });
});
