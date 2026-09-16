import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * The usage ledger's writer (P2-31, P0-30).
 *
 * **In `packages/db` rather than `packages/core/src/usage.ts` where the row
 * puts it**, on this package's standing terms: a statement lives where the
 * driver is (P0-09). What is pure — the price table, the cost, the period —
 * *is* in `packages/core/src/usage.ts`, which is the half of the row that
 * belongs there.
 *
 * **It takes the caller's transaction**, which the row requires rather than
 * suggests: the usage row and P2-30's turn are one write, or usage and history
 * disagree about what happened.
 *
 * **The table is append-only at the grant level** (P0-31, migration 0015): the
 * runtime role holds INSERT and nothing else. So this inserts and never
 * updates, and a correction is another row rather than an edit.
 */

export interface UsageToRecord {
  /** `YYYYMM`, from `periodOf`. The column's `CHECK` refuses anything else. */
  readonly period: string;
  /** `chat_message` for a turn. */
  readonly kind: string;
  /** The widget session, or null for work with no visitor behind it. */
  readonly sessionId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Integer micros, from `costMicrosFor`. Never a float. */
  readonly costMicros: number | null;
}

/**
 * Records one billable action.
 *
 * **Billed even when the model errored after being called** (the row is
 * explicit): the tokens were spent whether or not the answer arrived, and a
 * failure loop that costs the tenant nothing and us everything is the shape of
 * every runaway bill. What distinguishes the two is the turn row P2-30 writes
 * beside it in the same transaction, which carries the reply that never came.
 */
export const recordUsage = async (tx: DbTransaction, usage: UsageToRecord): Promise<void> => {
  await tx.execute(sql`
    insert into usage_events
      (tenant_id, period, kind, session_id, input_tokens, output_tokens, cost_micros)
    values (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${usage.period}, ${usage.kind}, ${usage.sessionId},
      ${usage.inputTokens}, ${usage.outputTokens}, ${usage.costMicros}
    )
  `);
};

/**
 * How many billable actions of one kind a tenant has taken this period (P2-36).
 *
 * **Counts rows, not tokens.** The tenant-facing limit is messages, because
 * that is the unit a seller understands and the unit the plan advertises — a
 * cap in tokens is a cap nobody can predict from their own behaviour.
 *
 * **An indexed equality on `(tenant_id, period)`**, which is what the column's
 * `YYYYMM` shape exists for: a range scan over `created_at` would do the same
 * arithmetic on the hot path, before every model call.
 */
export const countUsage = async (
  tx: DbTransaction,
  period: string,
  kind: string,
): Promise<number> => {
  const rows = await tx.execute(sql`
    select count(*)::int as used
    from usage_events
    where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and period = ${period}
      and kind = ${kind}
  `);

  const row = [...rows][0] as { used: number } | undefined;

  if (row === undefined) {
    /*
     * `count(*)` always returns a row, so this is unreachable — and it throws
     * rather than defaulting, because the default that suggests itself is
     * nought and nought is the answer that grants unlimited usage. A cost gate
     * whose read failed must not be a cost gate that let everything through,
     * which is the failure the `period` column's own comment warns about.
     */
    throw new Error('Counting usage returned no row (P2-31).');
  }

  return row.used;
};
