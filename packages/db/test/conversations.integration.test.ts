import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
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

  tenantId = await createTenant(db, 'chat');
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

    await db.execute(sql`delete from tenants where id = ${doomedId}::uuid`);

    const rows = await db.execute(
      sql`select count(*)::int as total from messages where tenant_id = ${doomedId}::uuid`,
    );
    expect([...rows][0]?.total).toBe(0);
  });
});
