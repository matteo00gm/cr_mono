import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { recordWidgetEvents, type EventBatch } from '../src/widget-events.js';
import { withTenant, type DbTransaction } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The analytics writer against real Postgres (P6-01).
 *
 * **What a batch may not decide** is the case this file exists for: it names a
 * product by id, and an id is something a page can copy from another winery's
 * storefront. Joined under the scope's own policy, a foreign id names nothing —
 * and a foreign key would not have stopped it, because Postgres checks
 * references without row-level security.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;
let otherTenantId: string;
let ownProduct: string;
let foreignProduct: string;

const addProduct = async (sku: string): Promise<string> => {
  const inserted = await db.execute(sql`
    insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${sku}, 'Barolo', 'RED', 3500, 'EUR', 'IN_STOCK')
    returning id
  `);

  return String([...inserted][0]?.id);
};

const startConversation = async (sessionId: string): Promise<string> => {
  const inserted = await db.execute(sql`
    insert into conversations (tenant_id, session_id, origin, locale)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${sessionId}, 'https://winery.example', 'it')
    returning id
  `);

  return String([...inserted][0]?.id);
};

interface EventRow {
  readonly tenant_id: string;
  readonly session_id: string;
  readonly conversation_id: string | null;
  readonly type: string;
  readonly product_id: string | null;
  readonly metadata: unknown;
  readonly created_at: Date | string;
}

const rowsFor = async (visitorId: string): Promise<EventRow[]> =>
  [
    ...(await db.execute(sql`
      select tenant_id, session_id, conversation_id, type, product_id, metadata, created_at
      from widget_events where session_id = ${visitorId}
      order by created_at, type
    `)),
  ] as unknown as EventRow[];

/** The transaction, counting every statement issued through it. */
const counting = (tx: DbTransaction, onStatement: () => void): DbTransaction =>
  new Proxy(tx, {
    get: (target, property, receiver) => {
      if (property === 'execute') onStatement();
      return Reflect.get(target, property, receiver) as unknown;
    },
  });

const record = (batch: EventBatch, scope = tenantId) =>
  withTenant(scope, (tx) => recordWidgetEvents(tx, batch), db);

const batchOf = (overrides: Partial<EventBatch> = {}): EventBatch => ({
  visitorId: `visitor-${randomUUID()}`,
  widgetSessionId: randomUUID(),
  events: [{ type: 'WIDGET_OPEN', productId: null, at: new Date('2026-10-01T10:00:00.000Z') }],
  ...overrides,
});

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  otherTenantId = await createTenant(db, 'altra');
  foreignProduct = await addProduct('SKU-ALTRA');

  tenantId = await createTenant(db, 'eventi-batch');
  ownProduct = await addProduct('SKU-NOSTRO');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await useTenant(db, tenantId);
});

describe('recording a batch', () => {
  it('writes every event, under the scope, stamped when it happened', async () => {
    const batch = batchOf({
      events: [
        { type: 'WIDGET_OPEN', productId: null, at: new Date('2026-10-01T10:00:00.000Z') },
        {
          type: 'PRODUCT_DETAIL_VIEW',
          productId: ownProduct,
          at: new Date('2026-10-01T10:00:01.000Z'),
        },
        { type: 'ADD_TO_CART', productId: ownProduct, at: new Date('2026-10-01T10:00:02.000Z') },
      ],
    });

    await expect(record(batch)).resolves.toBe(3);

    const rows = await rowsFor(batch.visitorId);

    expect(rows.map((row) => [row.type, row.product_id])).toEqual([
      ['WIDGET_OPEN', null],
      ['PRODUCT_DETAIL_VIEW', ownProduct],
      ['ADD_TO_CART', ownProduct],
    ]);
    expect(rows.every((row) => row.tenant_id === tenantId)).toBe(true);
    expect(new Date(rows[1]?.created_at ?? 0).toISOString()).toBe('2026-10-01T10:00:01.000Z');
  });

  it('groups by the visitor and carries the widget session beside it', async () => {
    const batch = batchOf();

    await record(batch);

    const [row] = await rowsFor(batch.visitorId);

    expect(row?.session_id).toBe(batch.visitorId);
    expect(row?.metadata).toEqual({ widgetSession: batch.widgetSessionId });
  });

  it('writes the batch in one statement', async () => {
    let statements = 0;

    await withTenant(
      tenantId,
      (tx) => {
        return recordWidgetEvents(
          counting(tx, () => (statements += 1)),
          batchOf({
            events: Array.from({ length: 20 }, () => ({
              type: 'RECOMMENDATION_SHOWN' as const,
              productId: ownProduct,
              at: new Date(),
            })),
          }),
        );
      },
      db,
    );

    expect(statements).toBe(1);
  });

  it('writes nothing, and asks nothing, for an empty batch', async () => {
    const batch = batchOf({ events: [] });
    let statements = 0;

    const accepted = await withTenant(
      tenantId,
      (tx) =>
        recordWidgetEvents(
          counting(tx, () => (statements += 1)),
          batch,
        ),
      db,
    );

    expect(accepted).toBe(0);
    expect(statements).toBe(0);
    expect(await rowsFor(batch.visitorId)).toHaveLength(0);
  });
});

describe('a product the winery does not hold', () => {
  it("is recorded as no product when it is another winery's", async () => {
    const batch = batchOf({
      events: [{ type: 'ADD_TO_CART', productId: foreignProduct, at: new Date() }],
    });

    await expect(record(batch)).resolves.toBe(1);

    const [row] = await rowsFor(batch.visitorId);

    expect(row?.type).toBe('ADD_TO_CART');
    expect(row?.product_id).toBeNull();
  });

  it('is recorded as no product when it is nobody’s, rather than failing the batch', async () => {
    const batch = batchOf({
      events: [
        { type: 'PRODUCT_DETAIL_VIEW', productId: randomUUID(), at: new Date() },
        { type: 'CART_OPEN', productId: null, at: new Date() },
      ],
    });

    await expect(record(batch)).resolves.toBe(2);
    expect((await rowsFor(batch.visitorId)).map((row) => row.product_id)).toEqual([null, null]);
  });
});

describe('the conversation', () => {
  it('is linked from the session the token named', async () => {
    const widgetSessionId = randomUUID();
    const conversationId = await startConversation(widgetSessionId);
    const batch = batchOf({ widgetSessionId });

    await record(batch);

    expect((await rowsFor(batch.visitorId))[0]?.conversation_id).toBe(conversationId);
  });

  it('is none before the visitor has asked anything', async () => {
    const batch = batchOf();

    await record(batch);

    expect((await rowsFor(batch.visitorId))[0]?.conversation_id).toBeNull();
  });

  it("is never another winery's, even for the same session id", async () => {
    const widgetSessionId = randomUUID();

    await useTenant(db, otherTenantId);
    await startConversation(widgetSessionId);
    await useTenant(db, tenantId);

    const batch = batchOf({ widgetSessionId });

    await record(batch);

    expect((await rowsFor(batch.visitorId))[0]?.conversation_id).toBeNull();
  });
});

describe('the scope', () => {
  it('is where the rows go, and the only place they can be read', async () => {
    const batch = batchOf();

    await record(batch, otherTenantId);

    expect(await rowsFor(batch.visitorId)).toHaveLength(0);

    await useTenant(db, otherTenantId);
    expect((await rowsFor(batch.visitorId)).map((row) => row.tenant_id)).toEqual([otherTenantId]);
  });
});
