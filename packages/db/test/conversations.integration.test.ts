import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { readConversation, recordTurn, type TurnToRecord } from '../src/conversations.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `conversations` and `messages` against real Postgres (P0-28).
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

const CHECK_VIOLATION = '23514';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let admin: DbClient | undefined;
let adminDb: Database;
let db: Database;
let tenantId: string;

const visitorHash = (value: string) => createHash('sha256').update(value).digest('hex');

const startConversation = (hash: string | null, sessionId = 'sess-1') =>
  db.execute(sql`
    insert into conversations (tenant_id, session_id, origin, visitor_hash, locale)
    values (${tenantId}::uuid, ${sessionId}, 'https://winery.example', ${hash}, 'it')
    returning id, started_at, last_message_at
  `);

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  // The cascade these suites assert is a property of the foreign key, not of
  // the runtime role — and P0-33a revoked DELETE on `tenants` from app_rw, so
  // only a role that still holds it can trigger the cascade at all.
  admin = createDbClient(started.adminUrl, { max: 1 });
  adminDb = admin.db;

  tenantId = await createTenant(db, 'chat');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await admin?.close();
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

describe('conversations', () => {
  it('accepts a salted hash as the visitor identifier', async () => {
    await expect(startConversation(visitorHash('203.0.113.42|salt'))).resolves.toBeDefined();
  });

  it.each([
    ['an IPv4 address', '203.0.113.42'],
    ['an IPv6 address', '2001:db8::1'],
    ['a truncated hash', visitorHash('x').slice(0, 32)],
    ['an uppercase hash', visitorHash('x').toUpperCase()],
    ['an email address', 'visitatore@example.com'],
  ])('refuses %s in visitor_hash', async (_label, value) => {
    // The privacy rule as a database constraint. An IP column is exactly the
    // kind of thing added "temporarily" for debugging that then lives in
    // backups for years — this makes adding it impossible rather than
    // discouraged.
    const error = await startConversation(value).catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('allows no visitor identifier at all', async () => {
    // Null is the correct value when a visitor has not been identified, and it
    // must not be forced into a placeholder that then looks like a real hash.
    await expect(startConversation(null, 'sess-anon')).resolves.toBeDefined();
  });

  it('keeps messages in order within a conversation', async () => {
    const conversation = await startConversation(visitorHash('ordered'), 'sess-ordered');
    const conversationId = String([...conversation][0]?.id);

    // Two statements rather than one multi-row insert. `now()` is the
    // transaction timestamp, so rows written by a single statement share a
    // created_at to the microsecond and come back in whatever order the heap
    // hands them over — there is no ordering to keep. Separate statements are
    // also how a real conversation arrives.
    await db.execute(sql`
      insert into messages (tenant_id, conversation_id, role, content, model, input_tokens, output_tokens, latency_ms)
      values (${tenantId}::uuid, ${conversationId}::uuid, 'USER', 'Che vino con il brasato?', null, null, null, null)
    `);
    await db.execute(sql`
      insert into messages (tenant_id, conversation_id, role, content, model, input_tokens, output_tokens, latency_ms)
      values (${tenantId}::uuid, ${conversationId}::uuid, 'ASSISTANT', 'Un Barolo.', 'nova-lite', 420, 88, 640)
    `);

    // created_at alone. `role` was a tiebreaker for rows that no longer tie,
    // and it never sorted the way it read: message_role is an enum, so it
    // orders by declaration order, not alphabetically.
    const rows = await db.execute(sql`
      select role, content from messages
      where conversation_id = ${conversationId}::uuid
      order by created_at
    `);

    expect([...rows].map((r) => r.role)).toEqual(['USER', 'ASSISTANT']);
  });

  it('keeps a recommendation auditable after the product is deleted', async () => {
    /*
     * The reason retrieved_product_ids is a plain uuid[] and not a join table
     * with a foreign key: this is a record of what was shown at the time.
     * Cascading it would erase the evidence along with the product, which is
     * exactly the record you want when a seller asks why something was
     * recommended.
     */
    const product = await db.execute(sql`
      insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
      values (${tenantId}::uuid, 'SKU-SHOWN', 'Barolo', 'RED', 3500, 'EUR', 'IN_STOCK')
      returning id
    `);
    const productId = String([...product][0]?.id);

    const conversation = await startConversation(visitorHash('audit'), 'sess-audit');
    const conversationId = String([...conversation][0]?.id);

    await db.execute(sql`
      insert into messages (tenant_id, conversation_id, role, content, retrieved_product_ids)
      values (${tenantId}::uuid, ${conversationId}::uuid, 'ASSISTANT', 'Ti consiglio questo.',
              array[${productId}::uuid])
    `);

    await db.execute(sql`delete from products where id = ${productId}::uuid`);

    const rows = await db.execute(
      sql`select retrieved_product_ids from messages where conversation_id = ${conversationId}::uuid`,
    );
    expect([...rows][0]?.retrieved_product_ids).toEqual([productId]);
  });

  it('deletes messages when their conversation is deleted', async () => {
    const conversation = await startConversation(visitorHash('cascade'), 'sess-cascade');
    const conversationId = String([...conversation][0]?.id);
    await db.execute(sql`
      insert into messages (tenant_id, conversation_id, role, content)
      values (${tenantId}::uuid, ${conversationId}::uuid, 'USER', 'ciao')
    `);

    await db.execute(sql`delete from conversations where id = ${conversationId}::uuid`);

    const rows = await db.execute(
      sql`select 1 from messages where conversation_id = ${conversationId}::uuid`,
    );
    expect([...rows]).toHaveLength(0);
  });

  it('deletes the whole history when the tenant is deleted', async () => {
    // What the P7-07 retention purge and a GDPR erasure both rely on.
    // Created through the helper, so the session is scoped to it: the rows
    // below could not otherwise be written, and the read afterwards could not
    // see them.
    const doomedId = await createTenant(db, 'gone');

    const conversation = await db.execute(sql`
      insert into conversations (tenant_id, session_id, origin, locale)
      values (${doomedId}::uuid, 's', 'https://gone.example', 'it')
      returning id
    `);
    await db.execute(sql`
      insert into messages (tenant_id, conversation_id, role, content)
      values (${doomedId}::uuid, ${String([...conversation][0]?.id)}::uuid, 'USER', 'ciao')
    `);

    await adminDb.execute(sql`delete from tenants where id = ${doomedId}::uuid`);

    const rows = await db.execute(
      sql`select count(*)::int as total from messages where tenant_id = ${doomedId}::uuid`,
    );
    expect([...rows][0]?.total).toBe(0);
  });
});

/**
 * Recording a turn (P2-30).
 *
 * The case that decides whether this is right is the second message of a
 * session. A turn that starts a new conversation each time produces a model
 * answering a follow-up having forgotten the question — and nothing errors,
 * nothing is slow, and §2.4 counts one visitor as two.
 */
interface Stamps {
  readonly started_at: string;
  readonly last_message_at: string;
}

const at = (stamp: string): number => new Date(stamp).getTime();

describe('recordTurn', () => {
  const turn = (overrides: Partial<TurnToRecord> = {}): TurnToRecord => ({
    sessionId: 'sess-turns',
    origin: 'https://winery.example',
    visitorHash: null,
    locale: 'it',
    question: 'qualcosa per una bistecca',
    reply: 'Le consiglio un Barolo.',
    retrievedProductIds: [],
    model: 'amazon.nova-lite-v1:0',
    inputTokens: 1200,
    outputTokens: 180,
    latencyMs: 2400,
    ...overrides,
  });

  const messagesOf = async (conversationId: string) =>
    [
      ...(await db.execute(sql`
        select role, content from messages
        where conversation_id = ${conversationId}::uuid
        order by created_at, role
      `)),
    ] as { role: string; content: string }[];

  it('opens a conversation and says that it did', async () => {
    const recorded = await withTenant(tenantId, (tx) => recordTurn(tx, turn()), db);

    expect(recorded.started).toBe(true);
    expect(await messagesOf(recorded.conversationId)).toEqual([
      { role: 'USER', content: 'qualcosa per una bistecca' },
      { role: 'ASSISTANT', content: 'Le consiglio un Barolo.' },
    ]);
  });

  it('appends to the same conversation on the next turn', async () => {
    const session = `sess-${randomUUID()}`;

    const first = await withTenant(
      tenantId,
      (tx) => recordTurn(tx, turn({ sessionId: session })),
      db,
    );
    const second = await withTenant(
      tenantId,
      (tx) => recordTurn(tx, turn({ sessionId: session, question: 'e con il pesce?' })),
      db,
    );

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.started).toBe(false);
    expect(await messagesOf(first.conversationId)).toHaveLength(4);
  });

  it('refuses a second conversation for one session, in the database', async () => {
    /*
     * The constraint rather than the code. Two turns arriving together would
     * both find no row and both insert one without it, and the failure is a
     * visitor whose follow-up is answered with no memory of the question.
     */
    const session = `sess-${randomUUID()}`;

    await withTenant(tenantId, (tx) => recordTurn(tx, turn({ sessionId: session })), db);

    await expect(
      db.execute(sql`
        insert into conversations (tenant_id, session_id, origin, locale)
        values (${tenantId}::uuid, ${session}, 'https://winery.example', 'it')
      `),
    ).rejects.toThrow();
  });

  it('moves last_message_at without moving started_at', async () => {
    const session = `sess-${randomUUID()}`;

    await withTenant(tenantId, (tx) => recordTurn(tx, turn({ sessionId: session })), db);
    const before = [
      ...(await db.execute(sql`
        select started_at, last_message_at from conversations where session_id = ${session}
      `)),
    ][0] as unknown as Stamps;

    await withTenant(tenantId, (tx) => recordTurn(tx, turn({ sessionId: session })), db);
    const after = [
      ...(await db.execute(sql`
        select started_at, last_message_at from conversations where session_id = ${session}
      `)),
    ][0] as unknown as Stamps;

    /*
     * Compared as the strings Postgres sent, which carry microseconds. Parsing
     * them through `Date` first truncates to the millisecond, and two turns can
     * land in the same one — at which point "it moved" and "it never moves"
     * look identical and the assertion proves nothing.
     */
    expect(after.started_at).toBe(before.started_at);
    expect(after.last_message_at).not.toBe(before.last_message_at);
    expect(at(after.last_message_at)).toBeGreaterThanOrEqual(at(before.last_message_at));
  });

  it('records what retrieval returned on the answer, not on the question', async () => {
    // What a complaint asks is what the model was *shown*. The question did not
    // retrieve anything; the answer was produced from a candidate set.
    const session = `sess-${randomUUID()}`;
    const shown = [randomUUID(), randomUUID()];

    const recorded = await withTenant(
      tenantId,
      (tx) => recordTurn(tx, turn({ sessionId: session, retrievedProductIds: shown })),
      db,
    );

    const rows = [
      ...(await db.execute(sql`
        select role, retrieved_product_ids from messages
        where conversation_id = ${recorded.conversationId}::uuid
        order by created_at, role
      `)),
    ] as { role: string; retrieved_product_ids: string[] | null }[];

    expect(rows[0]?.retrieved_product_ids).toBeNull();
    expect(rows[1]?.retrieved_product_ids).toEqual(shown);
  });

  it('keeps a candidate id after the wine is gone', async () => {
    /*
     * `retrieved_product_ids` is deliberately not a foreign key array: it is a
     * record of what was shown at the time, and it has to survive the product
     * being archived or deleted. A cascade would erase the evidence along with
     * the wine somebody is complaining about.
     */
    const session = `sess-${randomUUID()}`;
    const rows = await db.execute(sql`
      insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
      values (${tenantId}::uuid, ${`sku-${randomUUID()}`}, 'Barolo', 'red', 2000, 'EUR', 'IN_STOCK')
      returning id
    `);
    const productId = ([...rows][0] as { id: string }).id;

    const recorded = await withTenant(
      tenantId,
      (tx) => recordTurn(tx, turn({ sessionId: session, retrievedProductIds: [productId] })),
      db,
    );

    await adminDb.execute(sql`delete from products where id = ${productId}::uuid`);

    const kept = [
      ...(await db.execute(sql`
        select retrieved_product_ids from messages
        where conversation_id = ${recorded.conversationId}::uuid and role = 'ASSISTANT'
      `)),
    ][0] as { retrieved_product_ids: string[] };

    expect(kept.retrieved_product_ids).toEqual([productId]);
  });

  it('cannot reach another tenant session', async () => {
    const other = await createTenant(db, 'chat-other');
    const session = `sess-${randomUUID()}`;

    await withTenant(other, (tx) => recordTurn(tx, turn({ sessionId: session })), db);
    await useTenant(db, tenantId);

    const mine = await withTenant(tenantId, (tx) => readConversation(tx, session, 10), db);

    expect(mine).toEqual([]);
  });
});

describe('readConversation', () => {
  const session = `sess-read-${randomUUID()}`;

  const turn = (question: string, reply: string): TurnToRecord => ({
    sessionId: session,
    origin: 'https://winery.example',
    visitorHash: null,
    locale: 'it',
    question,
    reply,
    retrievedProductIds: [],
    model: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
  });

  it('returns a turn question first, though both rows share a timestamp', async () => {
    /*
     * Both messages of a turn are written in one statement, so `now()` gives
     * them the same value. Ordering by time alone can therefore put the answer
     * before the question — a history in which the model spoke first, which is
     * exactly the thing a model will try to make sense of.
     */
    await withTenant(tenantId, (tx) => recordTurn(tx, turn('domanda', 'risposta')), db);

    const history = await withTenant(tenantId, (tx) => readConversation(tx, session, 10), db);

    expect(history.map((message) => message.role)).toEqual(['USER', 'ASSISTANT']);
  });

  it('keeps the recent end when it has to choose', async () => {
    // P2-35 caps how much history a prompt carries, and a cap that kept the
    // oldest messages would send the model the opening of a conversation it is
    // being asked to continue.
    await withTenant(tenantId, (tx) => recordTurn(tx, turn('seconda', 'seconda risposta')), db);

    const history = await withTenant(tenantId, (tx) => readConversation(tx, session, 2), db);

    expect(history.map((message) => message.content)).toEqual(['seconda', 'seconda risposta']);
  });
});
