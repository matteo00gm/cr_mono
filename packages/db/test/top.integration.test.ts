import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { readTopProducts, readTopQueries } from '../src/top.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The top questions and wines against real Postgres (P6-03).
 *
 * One seeded week: the same question typed three ways, a question one visitor
 * asked five times, wines shown as cards and as mere candidates, adds in the
 * conversation that was shown the wine and in one that was not, a wine since
 * archived, one since deleted — and a second winery asking the same things.
 */

const START = new Date('2026-09-01T00:00:00.000Z');
const END = new Date('2026-09-08T00:00:00.000Z');
const IN_RANGE = '2026-09-03T12:00:00.000Z';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let admin: DbClient | undefined;
let db: Database;
let tenantId: string;
let otherTenantId: string;
let barolo: string;
let chianti: string;
let gone: string;

const wine = async (name: string): Promise<string> => {
  const rows = await db.execute(sql`
    insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${`sku-${randomUUID()}`},
            ${name}, 'red', 2000, 'EUR', 'IN_STOCK')
    returning id
  `);

  return String([...rows][0]?.id);
};

/** A conversation by session, created on first use. */
const conversation = async (session: string): Promise<string> => {
  const rows = await db.execute(sql`
    insert into conversations (tenant_id, session_id, origin, locale)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${session},
            'https://cantina.example', 'it')
    on conflict (tenant_id, session_id) do update set last_message_at = now()
    returning id
  `);

  return String([...rows][0]?.id);
};

/** A question and its answer, the answer showing these cards (`null`: written before P6-03). */
const turn = async (
  session: string,
  question: string,
  cards: readonly string[] | null = [],
  at = IN_RANGE,
): Promise<string> => {
  const id = await conversation(session);

  await db.execute(sql`
    insert into messages (tenant_id, conversation_id, role, content, created_at)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${id}::uuid, 'USER',
            ${question}, ${at}::timestamptz)
  `);
  await db.execute(sql`
    insert into messages (tenant_id, conversation_id, role, content, recommended_product_ids, created_at)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${id}::uuid, 'ASSISTANT',
            'Ecco.', ${cards === null ? null : `{${cards.join(',')}}`}::uuid[], ${at}::timestamptz)
  `);

  return id;
};

const added = (conversationId: string | null, productId: string, at = IN_RANGE) =>
  db.execute(sql`
    insert into widget_events (tenant_id, session_id, conversation_id, type, product_id, created_at)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, 'visitor-0001',
            ${conversationId}::uuid, 'ADD_TO_CART', ${productId}::uuid, ${at}::timestamptz)
  `);

const queries = (scope = tenantId, minConversations = 3, start = START, end = END) =>
  withTenant(scope, (tx) => readTopQueries(tx, { start, end, minConversations, limit: 10 }), db);

const products = (scope = tenantId, limit = 10, start = START, end = END) =>
  withTenant(scope, (tx) => readTopProducts(tx, { start, end, limit }), db);

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
  admin = createDbClient(started.adminUrl, { max: 1 });

  /* Another winery asking the same question, in as many conversations. */
  otherTenantId = await createTenant(db, 'altra-top');
  const theirs = await wine('Nero d’Avola');

  for (const session of ['o1', 'o2', 'o3']) {
    await turn(session, 'Un rosso per la bistecca', [theirs]);
  }

  tenantId = await createTenant(db, 'top');
  barolo = await wine('Barolo');
  chianti = await wine('Chianti Classico');
  gone = await wine('Vino tolto');

  /* One question, typed three ways, in three conversations. */
  const a = await turn('a', 'Un rosso per la bistecca', [barolo, chianti]);
  const b = await turn('b', '  un rosso   per la BISTECCA ', [barolo]);
  const c = await turn('c', 'UN ROSSO PER LA BISTECCA', [barolo, gone]);

  /* A fourth question in four conversations, so the order is by conversations. */
  for (const session of ['a', 'b', 'c', 'd']) await turn(session, 'Prosecco?');

  /* One visitor, five times: one conversation, below the threshold. */
  for (let asked = 0; asked < 5; asked += 1) await turn('d', 'vino dolce');

  /* Two conversations: still below it. */
  await turn('d', 'bianco frizzante');
  await turn('e', 'bianco frizzante', null);

  /* Three conversations, all the day before the range. */
  for (const session of ['f', 'g', 'h']) {
    await turn(session, 'fuori dal periodo', [barolo], '2026-08-31T23:59:59.999Z');
  }

  /* And three at its first excluded instant: the range is [start, end). */
  for (const session of ['i', 'j', 'k']) {
    await turn(session, 'dopo il periodo', [chianti], END.toISOString());
  }

  /* A second answer showing the same wine in one conversation: still one conversation. */
  await turn('b', 'e con il pesce?', [barolo]);

  /* Adds: in a conversation shown the wine, twice in one, in one not shown it, in none. */
  await added(a, barolo);
  await added(b, barolo);
  await added(b, barolo);
  await added(c, chianti);
  await added(null, barolo);
  /* Looking at a wine is not adding it. */
  await db.execute(sql`
    insert into widget_events (tenant_id, session_id, conversation_id, type, product_id, created_at)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, 'visitor-0001',
            ${a}::uuid, 'PRODUCT_DETAIL_VIEW', ${chianti}::uuid, ${IN_RANGE}::timestamptz)
  `);

  await db.execute(sql`update products set status = 'ARCHIVED' where id = ${chianti}::uuid`);
  await admin.db.execute(sql`delete from products where id = ${gone}::uuid`);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await admin?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await useTenant(db, tenantId);
});

describe('readTopQueries', () => {
  it('groups a question however it was typed, and counts conversations', async () => {
    const top = await queries();

    expect(top.map(({ query, conversations }) => [query, conversations])).toEqual([
      ['prosecco?', 4],
      ['un rosso per la bistecca', 3],
    ]);
  });

  it('leaves out a question below the threshold, however often one visitor asked it', async () => {
    const asked = (await queries()).map(({ query }) => query);

    expect(asked).not.toContain('vino dolce');
    expect(asked).not.toContain('bianco frizzante');
  });

  it('lists it once the threshold is lower, which is how the threshold is shown to be the cause', async () => {
    const top = await queries(tenantId, 1);

    expect(top.find(({ query }) => query === 'vino dolce')?.conversations).toBe(1);
    expect(top.find(({ query }) => query === 'bianco frizzante')?.conversations).toBe(2);
  });

  it('says when it was last asked', async () => {
    const [first] = await queries();

    expect(first?.lastAskedAt).toEqual(new Date(IN_RANGE));
  });

  it('counts only the range', async () => {
    expect((await queries()).map(({ query }) => query)).not.toContain('fuori dal periodo');
    expect((await queries()).map(({ query }) => query)).not.toContain('dopo il periodo');
    expect(
      (await queries(tenantId, 3, new Date('2026-08-31T00:00:00.000Z'), START)).map(
        ({ query }) => query,
      ),
    ).toEqual(['fuori dal periodo']);
  });

  it("is the scope's winery only: the other's three conversations add nothing", async () => {
    const mine = await queries();

    expect(mine.find(({ query }) => query === 'un rosso per la bistecca')?.conversations).toBe(3);
    expect((await queries(otherTenantId)).map(({ conversations }) => conversations)).toEqual([3]);
  });
});

describe('readTopProducts', () => {
  it('counts the conversations each wine was shown in, and the adds in those only', async () => {
    const top = await products();

    expect(top[0]).toEqual({
      productId: barolo,
      name: 'Barolo',
      archived: false,
      recommended: 3,
      added: 2,
    });
  });

  it('does not count an add in a conversation that was not shown the wine', async () => {
    const chiantiRow = (await products()).find(({ productId }) => productId === chianti);

    expect(chiantiRow?.recommended).toBe(1);
    expect(chiantiRow?.added).toBe(0);
  });

  it('keeps an archived wine, and says it is archived', async () => {
    const chiantiRow = (await products()).find(({ productId }) => productId === chianti);

    expect(chiantiRow).toMatchObject({ name: 'Chianti Classico', archived: true });
  });

  it('keeps a deleted wine’s row, with no name, rather than dropping it', async () => {
    const goneRow = (await products()).find(({ productId }) => productId === gone);

    expect(goneRow).toEqual({
      productId: gone,
      name: null,
      archived: false,
      recommended: 1,
      added: 0,
    });
  });

  it('lists the most recommended first, and no more than asked', async () => {
    expect((await products(tenantId, 1)).map(({ productId }) => productId)).toEqual([barolo]);
    expect(await products()).toHaveLength(3);
  });

  it('counts only the range', async () => {
    const before = await products(tenantId, 10, new Date('2026-08-31T00:00:00.000Z'), START);

    expect(before.map(({ productId, recommended }) => [productId, recommended])).toEqual([
      [barolo, 3],
    ]);
  });

  it("is the scope's winery only", async () => {
    const mine = (await products()).map(({ productId }) => productId);
    const theirs = await products(otherTenantId);

    expect(theirs).toHaveLength(1);
    expect(mine).not.toContain(theirs[0]?.productId);
  });
});
