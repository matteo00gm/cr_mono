import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `conversations` and `messages` — chat history (P0-28).
 *
 * Needed for conversational context, for the analytics in §2.4, and for the
 * retention purge in P7-07. Two tables in one module because a message without
 * its conversation is meaningless and the pair is always read together.
 */

export const messageRole = pgEnum('message_role', ['USER', 'ASSISTANT', 'SYSTEM']);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /** The widget session this belongs to (§3.4), not a login. */
    sessionId: text('session_id').notNull(),

    /** Which verified origin it came from — a tenant may have several (§2.4). */
    origin: text('origin').notNull(),

    /**
     * A salted hash, never a raw IP. The salt lives in SSM and rotates (§3.9).
     *
     * The `CHECK` below is what makes that a property of the database rather
     * than of every code path that writes here. GDPR aside, an IP column is the
     * kind of thing that gets added "temporarily" for debugging and then lives
     * in backups for years.
     */
    visitorHash: text('visitor_hash'),

    locale: text('locale').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * Exactly 64 lowercase hex characters — a SHA-256 digest and nothing else.
     *
     * An IPv4 address has dots, an IPv6 address has colons, and neither is 64
     * characters, so both are rejected by construction. "Never store a raw IP"
     * stops being a rule someone has to remember and becomes something the
     * database will not accept.
     */
    check('conversations_visitor_hash_is_sha256', sql`visitor_hash ~ '^[a-f0-9]{64}$'`),

    /** The purge job (P7-07) and every analytics panel scan this way. */
    index('conversations_tenant_started_idx').on(table.tenantId, table.startedAt.desc()),

    /**
     * One conversation per session (P2-30).
     *
     * A turn upserts by this pair, and without the constraint two messages
     * arriving close together each find no row and each insert one: the visitor
     * gets a second conversation with no history, the model answers the
     * follow-up having forgotten the question, and §2.4 counts one visitor as
     * two. Nothing errors.
     *
     * Scoped by tenant as well, because a session id is minted per tenant
     * (P2-12) and a global unique index would let one tenant's id collide with
     * another's.
     */
    uniqueIndex('conversations_tenant_session_key').on(table.tenantId, table.sessionId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    role: messageRole('role').notNull(),
    content: text('content').notNull(),

    /**
     * What retrieval actually returned, so a recommendation stays auditable
     * after the fact.
     *
     * Deliberately **not** a foreign key array — Postgres cannot express one,
     * and the intent is different anyway: this is a record of what was shown at
     * the time, which must survive the product being archived or deleted. A
     * cascade here would erase the evidence along with the product.
     */
    retrievedProductIds: uuid('retrieved_product_ids').array(),

    /**
     * The cards the visitor was shown (P6-03): the model's choice among the
     * candidates above, after the allowlist, in the order they were sent.
     *
     * Beside the candidates rather than instead of them, because they answer
     * different questions — what the model was *given*, which a complaint
     * asks, and what a visitor *saw*, which "top recommended wines" asks.
     * Counting the candidates would credit a wine with every answer it was
     * passed over in. Not a foreign key array, for the reason above: a wine
     * archived since is still a wine that was recommended. `null` on a
     * visitor's message, and on an answer written before this column existed.
     */
    recommendedProductIds: uuid('recommended_product_ids').array(),

    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),

    /**
     * The order messages were written in (review).
     *
     * `created_at` is transaction time, so two turns written in one
     * transaction share it, and a clock step can put a later turn before an
     * earlier one. A conversation read in `created_at` order then groups both
     * questions before both answers. An identity is assigned in the order rows
     * are inserted — and a turn's question is inserted before its answer, in
     * one statement — so it orders a conversation without asking the clock.
     */
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
  },
  (table) => [
    index('messages_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    /** Loading a conversation in order — the widget's own read path. */
    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    /** Loading it in the order it was written, which is what the history reads. */
    index('messages_conversation_seq_idx').on(table.conversationId, table.seq),
  ],
);
