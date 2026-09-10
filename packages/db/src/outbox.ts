import { and, inArray, isNull, lt, sql } from 'drizzle-orm';

import { outbox } from './schema/outbox.js';
import type { Database } from './client.js';
import type { DbTransaction } from './with-tenant.js';
import { withOutbox } from './with-outbox.js';

/**
 * Claiming and releasing outbox jobs (P1-31).
 *
 * The statements live here for the reason `index.ts` gives: no app imports a
 * driver. *What* to do with a claimed job — which queue it goes to, how a
 * partial send is reported — belongs to `apps/worker`, which is where the SQS
 * client is.
 *
 * Everything in this file runs inside `withOutbox`, which is where the reason a
 * cross-tenant read is allowed at all is written down. Read that before
 * changing anything here.
 */

/**
 * A claimed job, as the poller hands it to the queue.
 *
 * `tenantId` travels with the message because the worker has no other way to
 * learn it — and the worker opens `withTenant(tenantId)` on the other side, so
 * a job that named the wrong tenant would find no product rather than another
 * seller's.
 */
export interface OutboxJob {
  readonly id: number;
  readonly tenantId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/** How many rows one pass takes. Ten SQS batches of ten. */
export const CLAIM_LIMIT = 100;

/**
 * Past this many failed publishes a row is left alone.
 *
 * **Left alone, not deleted.** A row that has failed to *publish* six times is
 * almost never a bad row — it is a queue that was unreachable — so discarding
 * it would lose a wine's embedding for a reason that had nothing to do with the
 * wine. Skipping it keeps the poller moving without starving the rows behind
 * it, and leaves the evidence in place for whoever looks.
 *
 * The row stays visible to `countStuckJobs` precisely because nothing else will
 * now report it: no error is thrown, no message is sent, and the queue simply
 * gets shorter by one job that never went anywhere.
 */
export const MAX_PUBLISH_ATTEMPTS = 6;

/**
 * Claims up to `limit` unpublished jobs, oldest first.
 *
 * **`FOR UPDATE SKIP LOCKED` is the whole mechanism.** Two pollers running at
 * once — the schedule fires while an opportunistic run is still going — would
 * otherwise read the same rows and both publish them, one duplicate embedding
 * per job. `SKIP LOCKED` makes the second poller step over what the first is
 * holding and take the next hundred instead, so concurrency costs nothing.
 *
 * The lock is held until the caller's transaction commits, which is why the
 * whole claim-send-release sequence is one transaction: the rows are
 * unavailable to any other poller for exactly as long as it takes.
 */
export const claimOutboxJobs = async (
  tx: DbTransaction,
  limit: number = CLAIM_LIMIT,
): Promise<readonly OutboxJob[]> => {
  const rows = await tx
    .select({
      id: outbox.id,
      tenantId: outbox.tenantId,
      aggregateId: outbox.aggregateId,
      eventType: outbox.eventType,
      payload: outbox.payload,
      attempts: outbox.attempts,
    })
    .from(outbox)
    .where(and(isNull(outbox.processedAt), lt(outbox.attempts, MAX_PUBLISH_ATTEMPTS)))
    /*
     * By id, which is a `bigserial`. The schema module says why that column is
     * not a uuid: insertion order is what the poller wants, and a monotonic key
     * gives it for free.
     */
    .orderBy(outbox.id)
    .limit(limit)
    .for('update', { skipLocked: true });

  return rows;
};

/**
 * Marks jobs published. Call inside a tenant-scoped part of the transaction.
 *
 * **Called only after a successful send, and the ordering is the guarantee.**
 * Marking first and sending second loses a job on every crash in the gap — and
 * loses it silently, because a row with `processed_at` set looks exactly like
 * one that worked. Sending first risks a *duplicate* instead, which costs one
 * extra embedding and which the consumer is built to absorb: `queued` and
 * `embedded` are both no-ops from the state they lead to (P1-38).
 *
 * At-least-once with an idempotent consumer, rather than at-most-once with a
 * silent hole. `now()` rather than a JavaScript clock, so the timestamp is the
 * database's and not a Lambda's idea of the time.
 */
export const markOutboxPublished = async (
  tx: DbTransaction,
  ids: readonly number[],
): Promise<void> => {
  if (ids.length === 0) return;

  await tx
    .update(outbox)
    .set({ processedAt: sql`now()` })
    .where(inArray(outbox.id, [...ids]));
};

/**
 * Counts a failed publish, leaving the row claimable.
 *
 * The row stays unprocessed on purpose: a send that failed did not happen, and
 * the next pass should try it again. `attempts` is what eventually takes it out
 * of the working set without deleting it.
 */
export const recordPublishFailure = async (
  tx: DbTransaction,
  ids: readonly number[],
): Promise<void> => {
  if (ids.length === 0) return;

  await tx
    .update(outbox)
    .set({ attempts: sql`${outbox.attempts} + 1` })
    .where(inArray(outbox.id, [...ids]));
};

/**
 * How many jobs the poller has given up on.
 *
 * Separate from the drain, and cheap, because a queue that is quietly dropping
 * work looks exactly like a queue with nothing to do — both publish nothing.
 * This is the one number that tells them apart, and P1-50's triage reads it.
 */
export const countStuckJobs = async (tx: DbTransaction): Promise<number> => {
  const rows = await tx
    .select({ stuck: sql<number>`count(*)::int` })
    .from(outbox)
    .where(and(isNull(outbox.processedAt), sql`${outbox.attempts} >= ${MAX_PUBLISH_ATTEMPTS}`));

  return rows[0]?.stuck ?? 0;
};

export interface OutboxPass {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/**
 * Scopes the rest of the transaction to one tenant.
 *
 * **The poller's releases go through this, and that is what keeps the flag to a
 * read.** `tenant_isolation` on `outbox` admits the poller flag in `USING` and
 * not in `WITH CHECK`, so an UPDATE under the flag alone fails: the new row has
 * to satisfy the tenant branch. Setting the tenant here — from the row Postgres
 * returned, never from anything that arrived from outside — is what lets the
 * release succeed, and it is why a transaction holding the flag still cannot
 * insert a job naming a tenant it did not claim from.
 *
 * The same shape `withInvitation` uses: read under one context, then narrow to
 * the tenant the database itself produced before writing anything.
 */
const scopeTo = async (tx: DbTransaction, tenantId: string): Promise<void> => {
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
};

/**
 * Claims a batch, publishes it, and releases it — in one transaction.
 *
 * **The sequence is the correctness property, so it is a function rather than
 * three exported calls for a caller to make in order** — the same argument
 * `insertProduct` makes about its outbox write, and the same one
 * `withWebhookEvent` (P0-64b) makes about its claim. A caller assembling this
 * by hand is a caller who can put the mark before the send, and that ordering
 * has no failing test: it works perfectly until a process dies.
 *
 * `publish` returns the ids it managed to send. Anything it does not name is
 * counted as a failure, which is the right default for a function that reports
 * per-entry results: a send that came back ambiguous is retried, and the
 * consumer absorbs the duplicate.
 */
export const runOutboxPass = async (
  publish: (jobs: readonly OutboxJob[]) => Promise<readonly number[]>,
  options: { readonly limit?: number | undefined; readonly database?: Database | undefined } = {},
): Promise<OutboxPass> =>
  withOutbox(async (tx) => {
    const jobs = await claimOutboxJobs(tx, options.limit ?? CLAIM_LIMIT);
    if (jobs.length === 0) return { claimed: 0, published: 0, failed: 0 };

    const published = await publish(jobs);
    const sent = new Set(published);

    /*
     * Only ids this pass actually claimed. A publisher that returned an id from
     * a previous pass — a bug, but a plausible one in a batching client — would
     * otherwise mark a row this transaction never locked, and that row may be
     * in flight inside another poller right now.
     */
    const claimed = jobs.filter((job) => sent.has(job.id));
    const missed = jobs.filter((job) => !sent.has(job.id));

    /*
     * Released a tenant at a time, because `WITH CHECK` is tenant-only and the
     * poller's flag does not satisfy it. Grouping is not an optimisation — it
     * is the only way these updates are legal, and it is what stops the flag
     * being a write capability. Two statements per tenant with work in the
     * batch, which for the ordinary case is two statements total.
     */
    const tenants = new Set(jobs.map((job) => job.tenantId));

    for (const tenantId of tenants) {
      await scopeTo(tx, tenantId);
      await markOutboxPublished(
        tx,
        claimed.filter((job) => job.tenantId === tenantId).map((job) => job.id),
      );
      await recordPublishFailure(
        tx,
        missed.filter((job) => job.tenantId === tenantId).map((job) => job.id),
      );
    }

    return { claimed: jobs.length, published: claimed.length, failed: missed.length };
  }, options.database);
