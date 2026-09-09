import {
  SendMessageBatchCommand,
  SQSClient,
  type SendMessageBatchRequestEntry,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';
import { CLAIM_LIMIT, runOutboxPass, type OutboxJob, type OutboxPass } from '@catalogorosso/db';

/**
 * The outbox poller (P1-31).
 *
 * **Nothing drained the outbox before this.** `insertProduct` has written a job
 * row in the same transaction as every product since P0-36, which is what makes
 * "committed product implies queued embedding" true — and then the rows sat
 * there. Every wine created so far is `PENDING`, for ever, with no error
 * anywhere: the guarantee held perfectly and the queue had no consumer.
 *
 * This is the half that moves them: claim, publish, release, on a schedule.
 */

/**
 * The message the worker receives.
 *
 * **It carries a pointer, not a payload**, and that is the decision worth
 * defending. A message holding the wine's text would embed whatever was true
 * when the row was written; the worker instead re-reads the product and builds
 * the text from the row it finds (P1-33). Three things follow, and all three
 * are load-bearing:
 *
 * - **Order stops mattering.** Two edits in quick succession can be delivered
 *   in either order and both end at the current text, so a standard queue is
 *   enough and FIFO's per-group serialisation is not needed.
 * - **A redelivery is free.** SQS is at-least-once and `markOutboxPublished`
 *   deliberately sends before it marks, so duplicates happen by design. The
 *   second delivery finds the hash unchanged and does nothing (P1-34).
 * - **Nothing sensitive sits in a queue.** What crosses is a tenant id, a
 *   product id and a word.
 */
export interface EmbeddingMessage {
  readonly outboxId: number;
  readonly tenantId: string;
  readonly productId: string;
  /** `created`, `edited` — why the job exists, for the worker's logging. */
  readonly reason: string;
}

/** SQS's own maximum for `SendMessageBatch`. Not a tuning knob. */
const SQS_BATCH = 10;

/**
 * How many claim-publish rounds one invocation will do.
 *
 * A single pass of `CLAIM_LIMIT` and then waiting for the next schedule means a
 * 5,000-wine import drains at a hundred a minute — most of an hour during which
 * the seller's catalogue is half-searchable and nothing looks wrong. Looping
 * while there is work costs nothing when there is none: the first pass claims
 * zero rows and returns.
 *
 * Capped rather than unbounded because this runs in a Lambda with a wall clock.
 * Exceeding the timeout mid-transaction rolls back the claim, so the work is
 * not lost — but it is not published either, and an invocation that can never
 * finish would repeat that for ever.
 */
const MAX_PASSES = 20;

const toMessage = (job: OutboxJob): EmbeddingMessage => {
  const payload = (job.payload ?? {}) as { readonly reason?: unknown };

  return {
    outboxId: job.id,
    tenantId: job.tenantId,
    productId: job.aggregateId,
    reason: typeof payload.reason === 'string' ? payload.reason : job.eventType,
  };
};

const chunk = <T>(items: readonly T[], size: number): readonly (readonly T[])[] => {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

export interface PublisherOptions {
  readonly client?: SQSClient | undefined;
  readonly config?: SQSClientConfig | undefined;
  readonly queueUrl: string;
  /** Where a failed entry is reported. Injected so the tests can read it. */
  readonly onFailure?:
    ((info: { readonly id: number; readonly reason: string }) => void) | undefined;
}

/**
 * Sends claimed jobs to SQS and reports which ones landed.
 *
 * **Per-entry results, not per-batch.** `SendMessageBatch` answers with a
 * `Successful` list and a `Failed` list, and a batch where nine entries went and
 * one did not is the ordinary case rather than an edge. Treating the batch as
 * all-or-nothing would re-send the nine on the next pass — nine duplicate
 * embeddings for one failure, every time, which is exactly the sort of waste
 * that only shows up on the bill.
 *
 * A throw is different from a `Failed` entry and is handled as such: the request
 * never reached the service, so none of that chunk published, and the remaining
 * chunks still get their turn. Returning the ids that *did* land, rather than
 * propagating, is what lets one bad chunk cost one retry instead of a whole
 * pass.
 */
export const sqsPublisher = (
  options: PublisherOptions,
): ((jobs: readonly OutboxJob[]) => Promise<readonly number[]>) => {
  const client = options.client ?? new SQSClient(options.config ?? {});

  return async (jobs) => {
    const published: number[] = [];

    for (const group of chunk(jobs, SQS_BATCH)) {
      const entries: SendMessageBatchRequestEntry[] = group.map((job) => ({
        /*
         * Unique within the batch, and SQS restricts it to
         * `[a-zA-Z0-9_-]{1,80}` — the outbox id is a bigserial, so it satisfies
         * both without a mapping table to look the result back up through.
         */
        Id: String(job.id),
        MessageBody: JSON.stringify(toMessage(job)),
      }));

      try {
        const result = await client.send(
          new SendMessageBatchCommand({ QueueUrl: options.queueUrl, Entries: entries }),
        );

        for (const success of result.Successful ?? []) {
          if (success.Id !== undefined) published.push(Number(success.Id));
        }

        for (const failure of result.Failed ?? []) {
          /*
           * `Code` rather than `Message`, and that is the P0-56 rule applied to
           * a log rather than to a response. A provider's message is free text
           * that has historically carried endpoints and credentials; the code
           * is a closed set — `InternalError`, `InvalidParameterValue` — which
           * is both safe to write down and the more useful half for triage.
           */
          options.onFailure?.({ id: Number(failure.Id), reason: failure.Code ?? 'unknown' });
        }
      } catch (error) {
        /*
         * The whole chunk failed to reach SQS. Nothing is added to `published`,
         * so `runOutboxPass` counts every id in it as unsent and leaves the rows
         * claimable — which is the correct reading of a request that never
         * arrived.
         */
        for (const job of group) {
          /* The name, for the same reason the code is used above. */
          options.onFailure?.({
            id: job.id,
            reason: (error as { name?: string }).name ?? 'unknown',
          });
        }
      }
    }

    return published;
  };
};

export interface PollResult {
  readonly passes: number;
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/**
 * Drains the outbox until it is empty or the cap is reached.
 *
 * Stops on a pass that claimed less than a full batch, because that pass saw
 * the end of the queue. It also stops on a pass that published *nothing* while
 * claiming something: the queue is unreachable, and hammering it for nineteen
 * more rounds turns one outage into a row full of exhausted attempt counters.
 */
export const pollOutbox = async (
  publish: (jobs: readonly OutboxJob[]) => Promise<readonly number[]>,
  options: {
    readonly limit?: number | undefined;
    readonly maxPasses?: number | undefined;
    /**
     * The transaction, injected.
     *
     * The loop's stopping rules are the part of this file most likely to be
     * wrong — an unbounded drain and a poller that never returns are the same
     * bug — and they are worth testing without a database standing behind them.
     */
    readonly runPass?: typeof runOutboxPass | undefined;
  } = {},
): Promise<PollResult> => {
  const maxPasses = options.maxPasses ?? MAX_PASSES;
  const limit = options.limit ?? CLAIM_LIMIT;
  const runPass = options.runPass ?? runOutboxPass;
  const totals = { passes: 0, claimed: 0, published: 0, failed: 0 };

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result: OutboxPass = await runPass(publish, { limit });

    totals.passes += 1;
    totals.claimed += result.claimed;
    totals.published += result.published;
    totals.failed += result.failed;

    /*
     * A short batch means the claim reached the end of the queue, so the next
     * pass would be a round trip to learn there is nothing there. Rows another
     * poller is holding also make a batch short, and stopping on those is
     * correct too — somebody else is already publishing them.
     */
    if (result.claimed < limit) break;

    /*
     * Claimed something and published none of it: the queue is unreachable.
     * Nineteen more rounds would turn one outage into a hundred rows with
     * exhausted attempt counters, which is a far longer outage than the one
     * that caused it.
     */
    if (result.published === 0) break;
  }

  return totals;
};

/**
 * The Lambda entry point.
 *
 * One handler for both triggers — the EventBridge schedule and the
 * opportunistic invocation after a write — because they want the identical
 * thing and a second handler would be a second place for the ordering to be
 * got wrong. The schedule is what makes the opportunistic call optional rather
 * than load-bearing: if it never fires, nothing is lost, only delayed.
 */
export interface HandlerOptions {
  /** Where a publish failure is written. CloudWatch in production. */
  readonly log?: ((line: string) => void) | undefined;
  /**
   * The transaction, injected for the same reason `pollOutbox` takes one.
   *
   * Without it this function is only testable for the branch that throws — and
   * the branch that throws is the least interesting thing it does.
   */
  readonly runPass?: typeof runOutboxPass | undefined;
  readonly client?: SQSClient | undefined;
}

export const handler = async (
  _event?: unknown,
  _context?: unknown,
  options: HandlerOptions = {},
): Promise<PollResult> => {
  const log =
    options.log ??
    ((line: string) => {
      console.warn(line);
    });
  const queueUrl = process.env.EMBEDDING_QUEUE_URL;

  if (queueUrl === undefined || queueUrl === '') {
    /*
     * Refused rather than defaulted. A poller with no queue would claim rows,
     * fail to publish them, increment every attempt counter and eventually mark
     * the whole backlog as given up on — a misconfiguration that destroys the
     * queue quietly instead of failing at the first invocation.
     */
    throw new Error(
      'EMBEDDING_QUEUE_URL is unset. The poller will not run without a queue to publish to, ' +
        'because claiming jobs it cannot send exhausts their attempt counters (P1-31).',
    );
  }

  return pollOutbox(
    sqsPublisher({
      queueUrl,
      client: options.client,
      onFailure: ({ id, reason }) => {
        log(JSON.stringify({ event: 'outbox.publish_failed', outboxId: id, reason }));
      },
    }),
    { runPass: options.runPass },
  );
};
