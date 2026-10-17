import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * What the retention purge reads and deletes (P7-07, §3.9).
 *
 * **Statements only, on the caller's transaction**, and every one of them under
 * the boilerplate tenant policy: run inside `withTenant`, each touches one
 * winery's rows; run outside one, it touches none. The purge walks the tenant
 * directory and opens a scope per winery, as the usage rollup does (P5-13) —
 * there is no cross-tenant path here to widen.
 *
 * **A batch per statement.** Each delete takes at most `limit` rows, oldest
 * first, so no statement holds a lock on a winery's conversations for longer
 * than a batch takes; the job repeats until a batch comes back short.
 */

/** A winery's own retention period in days, or null for the default (migration 0078). */
export const readTranscriptRetention = async (tx: DbTransaction): Promise<number | null> => {
  const rows = await tx.execute(sql`SELECT transcript_retention_days FROM tenants LIMIT 1`);
  const row = [...rows][0] as { transcript_retention_days: number | null } | undefined;

  return row?.transcript_retention_days ?? null;
};

export interface PurgeBatch {
  /** Rows last active before this instant go. */
  readonly before: Date;
  readonly limit: number;
}

/**
 * Deletes up to `limit` conversations whose last message is older than `before`,
 * and their messages with them (`ON DELETE CASCADE`).
 *
 * **By the last message, not the first**: a conversation is kept for the period
 * after it ended, and one a visitor came back to is younger than it started.
 * `widget_events` point at a conversation with `ON DELETE SET NULL`, so the
 * funnel's counts outlive the words that were said.
 */
export const purgeConversations = async (
  tx: DbTransaction,
  { before, limit }: PurgeBatch,
): Promise<number> => {
  const rows = await tx.execute(sql`
    WITH doomed AS (
      SELECT id FROM conversations
      WHERE last_message_at < ${before.toISOString()}::timestamptz
      ORDER BY last_message_at
      LIMIT ${limit}
    )
    DELETE FROM conversations c USING doomed d WHERE c.id = d.id
    RETURNING 1
  `);

  return [...rows].length;
};

/** Up to `limit` widget events older than `before`, oldest first. */
export const purgeWidgetEvents = async (
  tx: DbTransaction,
  { before, limit }: PurgeBatch,
): Promise<number> => {
  const rows = await tx.execute(sql`
    WITH doomed AS (
      SELECT id FROM widget_events
      WHERE created_at < ${before.toISOString()}::timestamptz
      ORDER BY created_at
      LIMIT ${limit}
    )
    DELETE FROM widget_events e USING doomed d WHERE e.id = d.id
    RETURNING 1
  `);

  return [...rows].length;
};

/** What a purge would take, for the dry run: it reads what the deletes would, and writes nothing. */
export const countPurgeable = async (
  tx: DbTransaction,
  { conversationsBefore, eventsBefore }: { conversationsBefore: Date; eventsBefore: Date },
): Promise<{ conversations: number; events: number }> => {
  const rows = await tx.execute(sql`
    SELECT
      (SELECT count(*)::int FROM conversations
        WHERE last_message_at < ${conversationsBefore.toISOString()}::timestamptz) AS conversations,
      (SELECT count(*)::int FROM widget_events
        WHERE created_at < ${eventsBefore.toISOString()}::timestamptz) AS events
  `);
  const row = [...rows][0] as { conversations: number; events: number } | undefined;

  return { conversations: row?.conversations ?? 0, events: row?.events ?? 0 };
};
