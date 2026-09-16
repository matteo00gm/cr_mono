import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * Recording a turn (P2-30, P0-28).
 *
 * **In `packages/db` rather than `packages/core/src/conversations.ts` where the
 * row puts it**, on this package's standing terms: a statement lives where the
 * driver is (P0-09), and what is pure about a conversation — how many turns a
 * prompt carries, what a reply may say — is in `packages/core` already.
 *
 * **It takes the caller's transaction**, which is the row's requirement rather
 * than a convenience: the turn and P2-31's `usage_events` row must be one
 * transaction, or a crash between them leaves a conversation nobody was billed
 * for, or a bill for a conversation that does not exist.
 *
 * **Written after the stream completes.** A visitor who closes the tab
 * mid-answer still has the part that was generated recorded, because what was
 * generated was paid for. Writing as it streams would mean a row per delta.
 */

export interface TurnToRecord {
  /** The widget session (P2-12), which is what a conversation is keyed by. */
  readonly sessionId: string;
  /** The verified origin this came from. A tenant may have several (§2.4). */
  readonly origin: string;
  /** A salted SHA-256, or null. The column's `CHECK` refuses anything that is not (§3.9). */
  readonly visitorHash: string | null;
  readonly locale: string;
  /**
   * The visitor's message, verbatim.
   *
   * **Stored as typed, because §2.4's `ZERO_RESULTS` panel is the most
   * commercially valuable screen in the dashboard and it reads these.** A
   * normalised copy would answer "what did people search for" with what our
   * normaliser made of it. The 90-day purge (P7-07) is what bounds the cost.
   */
  readonly question: string;
  /** The reply as the visitor read it — after P2-27's cap, not before. */
  readonly reply: string;
  /**
   * What retrieval returned, so a past recommendation stays auditable.
   *
   * The candidates, not the cards: the question a complaint asks is what the
   * model was *shown*, and a list of what it chose cannot answer it.
   */
  readonly retrievedProductIds: readonly string[];
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;
}

export interface RecordedTurn {
  readonly conversationId: string;
  /** True when this turn opened the conversation. §2.4 counts sessions with it. */
  readonly started: boolean;
}

/**
 * Appends one question and one answer to a session's conversation.
 *
 * **The conversation is upserted, not selected-then-inserted.** Two messages
 * arriving close together would both find no row and both insert one, and the
 * visitor would get a second conversation with no history — so the model
 * answers the follow-up having forgotten the question, and nothing errors.
 * `ON CONFLICT` makes the database decide, which is the only place it can be
 * decided correctly.
 *
 * **`last_message_at` moves on every turn**, because the purge (P7-07) and the
 * analytics both ask when a conversation was last alive rather than when it
 * opened.
 */
export const recordTurn = async (tx: DbTransaction, turn: TurnToRecord): Promise<RecordedTurn> => {
  const tenant = sql`nullif(current_setting('app.tenant_id', true), '')::uuid`;

  const conversation = await tx.execute(sql`
    insert into conversations (tenant_id, session_id, origin, visitor_hash, locale)
    values (${tenant}, ${turn.sessionId}, ${turn.origin}, ${turn.visitorHash}, ${turn.locale})
    on conflict (tenant_id, session_id) do update
      set last_message_at = now()
    returning id, (xmax = 0) as inserted
  `);

  const row = [...conversation][0] as { id: string; inserted: boolean } | undefined;

  if (row === undefined) {
    /*
     * Unreachable through the policy rather than through a branch: the insert
     * is scoped to the tenant the setting names, so a row always comes back or
     * the statement raises. Checked because the alternative is a `!` that turns
     * a policy change into a crash three frames away.
     */
    throw new Error('Recording a turn returned no conversation (P2-30).');
  }

  /*
   * Both messages in one statement, so a concurrent turn cannot interleave
   * between them. They share a `created_at` — `now()` is transaction time — so
   * the order within a turn is not recoverable from the timestamp alone, and
   * `readConversation` below orders by `role` after it. The enum is declared
   * `USER, ASSISTANT, SYSTEM`, which is the order a turn happens in.
   */
  await tx.execute(sql`
    insert into messages
      (tenant_id, conversation_id, role, content, retrieved_product_ids,
       model, input_tokens, output_tokens, latency_ms)
    values
      (${tenant}, ${row.id}::uuid, 'USER', ${turn.question}, null, null, null, null, null),
      (${tenant}, ${row.id}::uuid, 'ASSISTANT', ${turn.reply},
       ${`{${turn.retrievedProductIds.join(',')}}`}::uuid[],
       ${turn.model}, ${turn.inputTokens}, ${turn.outputTokens}, ${turn.latencyMs})
  `);

  return { conversationId: row.id, started: row.inserted };
};

export interface RecordedMessage {
  readonly role: 'USER' | 'ASSISTANT' | 'SYSTEM';
  readonly content: string;
  readonly retrievedProductIds: readonly string[];
}

/**
 * A session's conversation, oldest first (P2-30, for P2-35's history).
 *
 * **Ordered by `created_at` and then `role`.** The two messages of one turn are
 * written in a single statement and share a transaction timestamp, so ordering
 * by time alone can put the answer before the question — a history in which the
 * model appears to have spoken first, which is exactly the thing a model will
 * try to make sense of.
 *
 * **The newest `limit` turns, returned oldest first.** P2-35 caps how much
 * history a prompt carries, and the cap has to keep the *recent* end.
 */
export const readConversation = async (
  tx: DbTransaction,
  sessionId: string,
  limit: number,
): Promise<RecordedMessage[]> => {
  const rows = await tx.execute(sql`
    select role, content, retrieved_product_ids
    from (
      select m.role, m.content, m.retrieved_product_ids, m.created_at
      from messages m
      join conversations c on c.id = m.conversation_id
      where c.session_id = ${sessionId}
        and c.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      order by m.created_at desc, m.role desc
      limit ${limit}
    ) recent
    order by created_at, role
  `);

  return [...rows].map((row) => {
    const {
      role,
      content,
      retrieved_product_ids: retrieved,
    } = row as {
      role: RecordedMessage['role'];
      content: string;
      retrieved_product_ids: string[] | null;
    };

    return { role, content, retrievedProductIds: retrieved ?? [] };
  });
};
