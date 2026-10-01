import { sql } from 'drizzle-orm';

import type { WidgetEventInsert } from './contracts.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * The analytics writer (P6-01): a widget batch, in one statement, under the
 * scope's tenant.
 *
 * **One statement for the batch**, as the row asks: the events arrive as one
 * JSON parameter and are spread by `jsonb_to_recordset`, so a batch of twenty is
 * one round trip and lands whole or not at all.
 *
 * **A product the tenant does not hold is kept as no product**, not trusted:
 * the id is joined against `products` under this scope's policy, so another
 * winery's id — guessed, or replayed from somebody else's page — names nothing.
 * The event still counts; it just points at no wine. A foreign key alone would
 * not do it: Postgres checks references without row-level security.
 *
 * **The conversation is ours to find**, from the widget session the token
 * named, never from anything the page sent.
 */

export interface EventToRecord {
  readonly type: WidgetEventInsert['type'];
  readonly productId: string | null;
  /** When it happened, already clamped to a believable window by the caller. */
  readonly at: Date;
}

export interface EventBatch {
  /** The anonymous per-tab id (P3-16): what a visit groups by, and what the cart line carries. */
  readonly visitorId: string;
  /** The session the verified token named: what the conversation is found by. */
  readonly widgetSessionId: string;
  readonly events: readonly EventToRecord[];
}

export const recordWidgetEvents = async (
  tx: DbTransaction,
  { visitorId, widgetSessionId, events }: EventBatch,
): Promise<number> => {
  if (events.length === 0) return 0;

  const rows = JSON.stringify(
    events.map((event) => ({
      type: event.type,
      product_id: event.productId,
      at: event.at.toISOString(),
    })),
  );

  const inserted = await tx.execute(sql`
    INSERT INTO widget_events (tenant_id, session_id, conversation_id, type, product_id, metadata, created_at)
    SELECT
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${visitorId},
      (SELECT c.id FROM conversations c WHERE c.session_id = ${widgetSessionId}),
      e.type::widget_event_type,
      p.id,
      jsonb_build_object('widgetSession', ${widgetSessionId}::text),
      e.at
    FROM jsonb_to_recordset(${rows}::jsonb) AS e(type text, product_id uuid, at timestamptz)
    LEFT JOIN products p ON p.id = e.product_id
    RETURNING id
  `);

  return [...inserted].length;
};
