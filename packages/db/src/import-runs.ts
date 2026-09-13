import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * Claiming and completing an import attempt (P1-26).
 *
 * Takes the caller's transaction and opens nothing, like every other write in
 * this package. The claim and the completion are **separate transactions on
 * purpose**: a claim has to be visible to a second request arriving while the
 * import runs, which it cannot be until it commits.
 */

/**
 * How long a claim with no result is taken to be still running.
 *
 * **Fifteen minutes is the longest an AWS Lambda can run**, so a claim older
 * than that belongs to an invocation that no longer exists — killed by a timeout
 * or a deploy between its claim and its completion. Without an expiry that key
 * would answer "still running" forever, and a seller retrying the same import
 * would be refused for the rest of time.
 */
export const IMPORT_CLAIM_EXPIRES_AFTER_MINUTES = 15;

export type ImportRunClaim =
  | { readonly outcome: 'claimed'; readonly runId: string }
  | { readonly outcome: 'replay'; readonly result: unknown }
  | { readonly outcome: 'different-body' }
  | { readonly outcome: 'in-progress' };

export interface ImportRunRequest {
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

/**
 * Claims a key for this attempt, or says why it cannot.
 *
 * **One statement decides the claim**, so two requests with the same key
 * cannot both win: the unique constraint admits one insert, and the conflict
 * branch only takes over a claim that has no result, carries the same body and
 * is past its expiry. Everything else falls through to a read of the row that
 * won, which says what the loser should be told.
 *
 * A key belonging to another winery never conflicts, because the constraint is
 * per tenant — and RLS keeps the read below from seeing it either way.
 *
 * **There is no release.** A failed attempt still stores its answer (an import
 * that stops part-way reports how far it got, and that report is the result),
 * so the only claim left without one is an invocation that died — which is
 * what the expiry is for. A release on error would run on the same connection
 * that just failed to store the result, and fail the same way.
 */
export const claimImportRun = async (
  tx: DbTransaction,
  request: ImportRunRequest,
): Promise<ImportRunClaim> => {
  const expiry = sql.raw(`interval '${String(IMPORT_CLAIM_EXPIRES_AFTER_MINUTES)} minutes'`);

  const claimed = await tx.execute(sql`
    INSERT INTO import_runs (tenant_id, idempotency_key, request_hash)
    VALUES (${request.tenantId}::uuid, ${request.idempotencyKey}, ${request.requestHash})
    ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
       SET claimed_at = now()
     WHERE import_runs.result IS NULL
       AND import_runs.request_hash = excluded.request_hash
       AND import_runs.claimed_at < now() - ${expiry}
    RETURNING id
  `);

  const [won] = [...claimed] as { id: string }[];
  if (won !== undefined) return { outcome: 'claimed', runId: won.id };

  const existing = await tx.execute(sql`
    SELECT request_hash, result
      FROM import_runs
     WHERE tenant_id = ${request.tenantId}::uuid
       AND idempotency_key = ${request.idempotencyKey}
  `);

  const [run] = [...existing] as { request_hash: string; result: unknown }[];

  if (run === undefined) {
    // Unreachable: the conflict above was on a row this tenant owns and can read.
    throw new Error('claimImportRun: the conflicting run is not visible to this tenant');
  }

  if (run.request_hash !== request.requestHash) return { outcome: 'different-body' };

  return run.result === null
    ? { outcome: 'in-progress' }
    : { outcome: 'replay', result: run.result };
};

/** Stores the response an attempt returned, which is what a replay answers with. */
export const completeImportRun = async (
  tx: DbTransaction,
  run: { readonly runId: string; readonly result: unknown },
): Promise<void> => {
  await tx.execute(sql`
    UPDATE import_runs
       SET result = ${JSON.stringify(run.result)}::jsonb,
           completed_at = now()
     WHERE id = ${run.runId}::uuid
  `);
};
