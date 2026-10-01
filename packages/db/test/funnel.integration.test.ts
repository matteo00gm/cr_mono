import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { readFunnel } from '../src/funnel.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The funnel's counts against real Postgres (P6-02).
 *
 * One seeded week, with a visit for every shape that is easy to count wrong:
 * one that skipped a stage, one that opened twice, one whose only events are
 * not stages, one that began before the range, and the edges of the range
 * itself. And a second winery whose visits share an id with the first's.
 */

const STAGES = ['WIDGET_OPEN', 'MESSAGE_SENT', 'RECOMMENDATION_SHOWN', 'ADD_TO_CART'] as const;

const START = new Date('2026-09-01T00:00:00.000Z');
const END = new Date('2026-09-08T00:00:00.000Z');
const IN_RANGE = '2026-09-03T12:00:00.000Z';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;
let otherTenantId: string;

/** One event, at a given moment, under whichever tenant the session is scoped to. */
const event = (session: string, type: string, at = IN_RANGE) =>
  db.execute(sql`
    insert into widget_events (tenant_id, session_id, type, created_at)
    values (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${session}, ${type}::widget_event_type, ${at}::timestamptz
    )
  `);

const read = (scope = tenantId, start = START, end = END) =>
  withTenant(scope, (tx) => readFunnel(tx, { stages: STAGES, start, end }), db);

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  /* Another winery, whose visits reuse the first one's ids and must never count for it. */
  otherTenantId = await createTenant(db, 'altra-funnel');
  for (const type of STAGES) await event('full', type);
  await event('other-only', 'WIDGET_OPEN');

  tenantId = await createTenant(db, 'funnel');

  /* Every stage, in order. */
  for (const type of STAGES) await event('full', type);
  /* Stopped at the recommendation. */
  for (const type of STAGES.slice(0, 3)) await event('shown', type);
  /* Asked, and left. */
  await event('asked', 'WIDGET_OPEN');
  await event('asked', 'MESSAGE_SENT');
  /* Opened twice in one visit, and nothing else: one visit, not two. */
  await event('twice', 'WIDGET_OPEN');
  await event('twice', 'WIDGET_OPEN', '2026-09-04T09:00:00.000Z');
  /* Its open was lost: an add to cart with nothing before it. */
  await event('skipped', 'ADD_TO_CART');
  /* Asked, then browsed: the browsing is not a stage. */
  await event('browsed', 'MESSAGE_SENT');
  await event('browsed', 'PRODUCT_DETAIL_VIEW');
  await event('browsed', 'CART_OPEN');
  /* Only events that are not stages: not a visit to this funnel at all. */
  await event('unanswered', 'ZERO_RESULTS');
  /* Opened the night before the range, bought inside it. */
  await event('straddling', 'WIDGET_OPEN', '2026-08-31T23:30:00.000Z');
  await event('straddling', 'ADD_TO_CART', '2026-09-01T00:15:00.000Z');
  /* The edges: the range is [start, end). */
  await event('first-instant', 'WIDGET_OPEN', START.toISOString());
  await event('last-instant', 'WIDGET_OPEN', '2026-09-07T23:59:59.999Z');
  await event('before', 'WIDGET_OPEN', '2026-08-31T23:59:59.999Z');
  await event('after', 'WIDGET_OPEN', END.toISOString());
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await useTenant(db, tenantId);
});

describe('readFunnel', () => {
  it('matches the seeded week, stage by stage', async () => {
    /*
     * Reached at least:
     *   open    — full, shown, asked, twice, skipped, browsed, straddling, first-instant, last-instant
     *   message — full, shown, asked, skipped, browsed, straddling
     *   shown   — full, shown, skipped, straddling
     *   cart    — full, skipped, straddling
     */
    expect(await read()).toEqual([9, 6, 4, 3]);
  });

  it('counts a visit that skipped a stage at every stage up to the one it reached', async () => {
    const counts = await withTenant(
      tenantId,
      (tx) => readFunnel(tx, { stages: ['ADD_TO_CART'], start: START, end: END }),
      db,
    );

    /* `full`, `skipped` and `straddling` added to the cart; nothing else did. */
    expect(counts).toEqual([3]);
  });

  it('counts a visit once, however many times it opened the widget', async () => {
    const counts = await withTenant(
      tenantId,
      (tx) =>
        readFunnel(tx, {
          stages: ['WIDGET_OPEN'],
          start: new Date('2026-09-04T00:00:00.000Z'),
          end: new Date('2026-09-05T00:00:00.000Z'),
        }),
      db,
    );

    /* Only `twice` has an event on the 4th — two opens, one visit. */
    expect(counts).toEqual([1]);
  });

  it('never grows down the funnel', async () => {
    const counts = await read();

    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('counts only what happened inside [start, end)', async () => {
    /* A day with nothing but the straddling visit's open, before the range began. */
    expect(await read(tenantId, new Date('2026-08-31T00:00:00.000Z'), START)).toEqual([2, 0, 0, 0]);
    /* The day after the range: only `after`. */
    expect(await read(tenantId, END, new Date('2026-09-09T00:00:00.000Z'))).toEqual([1, 0, 0, 0]);
  });

  it('answers zeros, one per stage, for a range with no visits', async () => {
    expect(
      await read(
        tenantId,
        new Date('2025-01-01T00:00:00.000Z'),
        new Date('2025-01-02T00:00:00.000Z'),
      ),
    ).toEqual([0, 0, 0, 0]);
  });

  it("is the scope's winery only, though the other's visits share its ids", async () => {
    expect(await read(otherTenantId)).toEqual([2, 1, 1, 1]);
  });

  it('reads nothing at all without a tenant in scope', async () => {
    await db.execute(sql`select set_config('app.tenant_id', '', false)`);

    const counts = await db.transaction((tx) =>
      readFunnel(tx, { stages: STAGES, start: START, end: END }),
    );

    expect(counts).toEqual([0, 0, 0, 0]);
  });
});
