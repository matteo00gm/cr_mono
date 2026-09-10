/**
 * The numbers the embedding pipeline is built from, and the rules that bind
 * them (P1-32).
 *
 * **Separate from `queue.ts` so they can be tested.** That module constructs
 * SST resources at import time and needs `$app` and the `sst.*` globals, so
 * nothing can load it outside a deploy — which would leave the figures below
 * checked by nobody. They are the ones where being wrong is silent: a
 * visibility timeout under the handler's own budget produces duplicate work and
 * no error, and a concurrency raised on its own exhausts `max_connections`
 * while the symptom reads as an application fault.
 */

/**
 * How long the worker may take on one batch.
 *
 * Ten messages, each one product: a read, at most one Bedrock call, an upsert.
 * Titan's retry ladder is four attempts with up to five seconds of jittered
 * backoff, so one throttled message can legitimately take ~20 seconds — and ten
 * of those in sequence is the worst case this has to survive without the batch
 * being redelivered mid-flight.
 */
export const WORKER_TIMEOUT_SECONDS = 300;

/**
 * The multiple the visibility timeout must clear.
 *
 * **A visibility timeout shorter than the handler is the classic SQS
 * misconfiguration**, and it produces no error anywhere: SQS redelivers a
 * message that is still being processed, two workers embed the same wine, both
 * pay, and the second overwrites the first. Six rather than the bare minimum
 * leaves room for a cold start and an ENI attachment on top of the handler's
 * own budget.
 */
export const VISIBILITY_MULTIPLE = 6;

export const VISIBILITY_TIMEOUT_SECONDS = WORKER_TIMEOUT_SECONDS * VISIBILITY_MULTIPLE;

/**
 * Deliveries before a message is set aside.
 *
 * The worker already retries *inside* one attempt — Titan's ladder is four
 * calls — so three deliveries is up to twelve provider calls before a message
 * reaches the DLQ. Past that the failure is almost never transient, and
 * retrying turns one bad product into a permanent share of the throughput.
 */
export const MAX_RECEIVE_COUNT = 3;

/** SQS's own maximum for a Lambda event source batch. */
export const BATCH_SIZE = 10;

/** Fourteen days, the SQS maximum, against the four-day default. */
export const DLQ_RETENTION_SECONDS = 1_209_600;

/**
 * The connection budget, in one place because these numbers must move together.
 *
 * `db.t4g.micro` allows roughly 100 connections. The API is capped at 10
 * concurrent × 2 per container = 20; the worker at 5 × 2 = 10. Thirty in use,
 * leaving headroom for sweep jobs, migrations and a human with `psql`.
 */
export const CONNECTIONS = {
  /** Postgres `max_connections` on the instance class in `database.ts`. */
  instanceMax: 100,
  apiConcurrency: 10,
  workerConcurrency: 5,
  perContainer: 2,
} as const;

export type ConnectionBudget = typeof CONNECTIONS;

/** How many connections the API and worker together can hold at their caps. */
export const budgetedConnections = (budget: ConnectionBudget = CONNECTIONS): number =>
  (budget.apiConcurrency + budget.workerConcurrency) * budget.perContainer;

/**
 * Throws when the two concurrency caps outgrow the instance.
 *
 * **Called at synth time rather than written in a comment**, because a comment
 * saying "these add up" stops being true the moment somebody raises one and
 * nothing fails. Half the instance's connections is the ceiling: the other half
 * is not slack, it is migrations, the sweep jobs, and a human with `psql`
 * during the incident that raising the concurrency caused.
 */
export const assertConnectionBudget = (budget: ConnectionBudget = CONNECTIONS): void => {
  const budgeted = budgetedConnections(budget);
  const ceiling = budget.instanceMax / 2;

  if (budgeted > ceiling) {
    throw new Error(
      `The API and worker together budget ${String(budgeted)} of the instance's ` +
        `${String(budget.instanceMax)} connections, past the ${String(ceiling)} this ` +
        'leaves for migrations, sweep jobs and a human with psql. Raise the instance ' +
        'class in infra/database.ts before raising either concurrency (P1-32).',
    );
  }
};

/**
 * Throws when the visibility timeout no longer covers the handler.
 *
 * Same argument as above, for the number whose failure is duplicate work rather
 * than an outage — and therefore the one more likely to be lowered by somebody
 * trying to make redelivery faster.
 */
export const assertVisibilityCoversHandler = (
  visibilitySeconds: number = VISIBILITY_TIMEOUT_SECONDS,
  handlerSeconds: number = WORKER_TIMEOUT_SECONDS,
): void => {
  if (visibilitySeconds < handlerSeconds * VISIBILITY_MULTIPLE) {
    throw new Error(
      `The visibility timeout (${String(visibilitySeconds)}s) is under ` +
        `${String(VISIBILITY_MULTIPLE)}× the worker timeout (${String(handlerSeconds)}s). ` +
        'SQS would redeliver messages that are still being processed, and the only ' +
        'symptom would be duplicate embeddings on the bill (P1-32).',
    );
  }
};
