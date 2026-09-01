import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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

    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('messages_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
    /** Loading a conversation in order — the widget's own read path. */
    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
  ],
);
