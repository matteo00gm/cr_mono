import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `widget_events` against real Postgres (P0-29).
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

const INVALID_ENUM = '22P02';

const EVENT_TYPES = [
  'WIDGET_OPEN',
  'MESSAGE_SENT',
  'RECOMMENDATION_SHOWN',
  'PRODUCT_DETAIL_VIEW',
  'ADD_TO_CART',
  'CART_OPEN',
  'ZERO_RESULTS',
] as const;

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  const tenant = await db.execute(
    sql`insert into tenants (name, slug) values ('Eventi', 'eventi') returning id`,
  );
  tenantId = String([...tenant][0]?.id);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

describe('widget_events', () => {
  it.each(EVENT_TYPES)('accepts a %s event', async (type) => {
    await expect(
      db.execute(sql`
        insert into widget_events (tenant_id, session_id, type)
        values (${tenantId}::uuid, 'sess-types', ${type}::widget_event_type)
      `),
    ).resolves.toBeDefined();
  });

  it('rejects an event type outside the set', async () => {
    // The panels in §2.4 are written against these names; a typo that reaches
    // the table is a row no panel will ever count.
    const error = await db
      .execute(
        sql`insert into widget_events (tenant_id, session_id, type)
            values (${tenantId}::uuid, 'sess-bad', 'WIDGET_CLOSED'::widget_event_type)`,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INVALID_ENUM);
  });

  it('records an event before any conversation exists', async () => {
    // WIDGET_OPEN is the first thing that happens.
    const rows = await db.execute(sql`
      insert into widget_events (tenant_id, session_id, type)
      values (${tenantId}::uuid, 'sess-open', 'WIDGET_OPEN')
      returning conversation_id, product_id
    `);

    expect([...rows][0]).toEqual({ conversation_id: null, product_id: null });
  });

  it('round-trips metadata as structured json', async () => {
    // The ZERO_RESULTS panel reads the query out of here, so it has to come
    // back as a value rather than a string that needs parsing.
    await db.execute(sql`
      insert into widget_events (tenant_id, session_id, type, metadata)
      values (${tenantId}::uuid, 'sess-meta', 'ZERO_RESULTS',
              ${{ query: 'vino per sushi', retrieved: 0 }})
    `);

    const rows = await db.execute(
      sql`select metadata from widget_events where session_id = 'sess-meta'`,
    );

    expect([...rows][0]?.metadata).toEqual({ query: 'vino per sushi', retrieved: 0 });
  });

  it('keeps the event when its product is deleted', async () => {
    /*
     * The reason product_id is `set null` rather than cascade: an archived or
     * deleted product must not erase the add-to-cart events it earned. With
     * cascade, every historical conversion rate changes retroactively — and it
     * changes downward, silently, which is the worst kind of wrong number.
     */
    const product = await db.execute(sql`
      insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
      values (${tenantId}::uuid, 'SKU-EVT', 'Barolo', 'RED', 3500, 'EUR', 'IN_STOCK')
      returning id
    `);
    const productId = String([...product][0]?.id);

    await db.execute(sql`
      insert into widget_events (tenant_id, session_id, type, product_id)
      values (${tenantId}::uuid, 'sess-cart', 'ADD_TO_CART', ${productId}::uuid)
    `);
    await db.execute(sql`delete from products where id = ${productId}::uuid`);

    const rows = await db.execute(
      sql`select type, product_id from widget_events where session_id = 'sess-cart'`,
    );

    expect([...rows][0]).toEqual({ type: 'ADD_TO_CART', product_id: null });
  });

  it('keeps the event when its conversation is purged', async () => {
    // P7-07 deletes old conversations. The funnel counts must survive that, or
    // the analytics shrink as data ages out.
    const conversation = await db.execute(sql`
      insert into conversations (tenant_id, session_id, origin, locale)
      values (${tenantId}::uuid, 'sess-purge', 'https://winery.example', 'it')
      returning id
    `);
    const conversationId = String([...conversation][0]?.id);

    await db.execute(sql`
      insert into widget_events (tenant_id, session_id, type, conversation_id)
      values (${tenantId}::uuid, 'sess-purge', 'MESSAGE_SENT', ${conversationId}::uuid)
    `);
    await db.execute(sql`delete from conversations where id = ${conversationId}::uuid`);

    const rows = await db.execute(
      sql`select session_id, conversation_id from widget_events where session_id = 'sess-purge'`,
    );

    // session_id is what makes the funnel still reconstructable.
    expect([...rows][0]).toEqual({ session_id: 'sess-purge', conversation_id: null });
  });

  it('deletes events when the tenant is deleted', async () => {
    const doomed = await db.execute(
      sql`insert into tenants (name, slug) values ('Via', 'via') returning id`,
    );
    const doomedId = String([...doomed][0]?.id);
    await db.execute(sql`
      insert into widget_events (tenant_id, session_id, type)
      values (${doomedId}::uuid, 's', 'WIDGET_OPEN')
    `);

    await db.execute(sql`delete from tenants where id = ${doomedId}::uuid`);

    const rows = await db.execute(
      sql`select 1 from widget_events where tenant_id = ${doomedId}::uuid`,
    );
    expect([...rows]).toHaveLength(0);
  });
});
