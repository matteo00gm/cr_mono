/// <reference path="../.sst/platform/config.d.ts" />

import { databaseUrl, parameterReadPermissions } from './config';
import {
  assertConnectionBudget,
  assertVisibilityCoversHandler,
  BATCH_SIZE,
  CONNECTIONS,
  DLQ_RETENTION_SECONDS,
  MAX_RECEIVE_COUNT,
  VISIBILITY_TIMEOUT_SECONDS,
  WORKER_TIMEOUT_SECONDS,
} from './queue-config';
import { vpc } from './vpc';

/**
 * The embedding queue, its consumer, and the poller that feeds it (P1-32).
 *
 * Three resources that only make sense together: `insertProduct` writes an
 * outbox row in the product's transaction (P0-36), the poller drains that table
 * onto this queue (P1-31), and the worker turns each message into a vector
 * (P1-37). Any one of them missing is a catalogue that looks fine and cannot be
 * searched.
 */

/**
 * The worker timeout as the literal SST's type wants.
 *
 * The figure itself, and every rule that depends on it, is in `queue-config.ts`
 * — that module can be imported by a test, and this one cannot. Asserted rather
 * than assumed to agree: two constants that must match is exactly how a
 * visibility timeout ends up shorter than the handler it covers.
 */
const WORKER_TIMEOUT = '300 seconds' as const;

if (Number.parseInt(WORKER_TIMEOUT, 10) !== WORKER_TIMEOUT_SECONDS) {
  throw new Error(
    `The Lambda timeout literal (${WORKER_TIMEOUT}) and WORKER_TIMEOUT_SECONDS ` +
      `(${String(WORKER_TIMEOUT_SECONDS)}) disagree. Every other figure here is derived ` +
      'from the second one (P1-32).',
  );
}

assertVisibilityCoversHandler();
assertConnectionBudget();

/**
 * The dead-letter queue.
 *
 * Declared before the main queue because the redrive policy names it, and
 * created even though nothing routinely lands here: a queue with no DLQ drops
 * a message it cannot process after the retention period, silently. This is
 * where P1-50's triage looks.
 */
export const embeddingDlq = new sst.aws.Queue('EmbeddingDlq', {
  transform: {
    queue: {
      /*
       * Fourteen days, the SQS maximum, against the queue's four-day default.
       * A DLQ's whole purpose is to hold a message until a human looks, and the
       * realistic gap between a Friday incident and somebody investigating is
       * longer than four days.
       */
      messageRetentionSeconds: DLQ_RETENTION_SECONDS,
    },
  },
});

/**
 * The embedding queue.
 *
 * **Standard, not FIFO**, and that is a consequence of P1-31's message design
 * rather than a default. A message names a product; the worker re-reads the row
 * and embeds whatever is current. So two edits delivered out of order both end
 * at the right text, and FIFO's per-group serialisation would buy ordering
 * nothing depends on while capping throughput at 300 messages a second per
 * group.
 */
export const embeddingQueue = new sst.aws.Queue('EmbeddingQueue', {
  transform: {
    queue: {
      visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,

      /**
       * Three attempts, then the DLQ.
       *
       * The worker already retries *inside* one attempt — Titan's ladder is
       * four calls with jittered backoff — so three deliveries is up to twelve
       * provider calls before a message is set aside. Past that the failure is
       * almost never transient, and continuing to retry turns one bad product
       * into a permanent share of the queue's throughput.
       */
      redrivePolicy: $jsonStringify({
        deadLetterTargetArn: embeddingDlq.arn,
        maxReceiveCount: MAX_RECEIVE_COUNT,
      }),
    },
  },
});

/**
 * The consumer (P1-37).
 *
 * `arm64` and `nodejs22.x` for the reasons `infra/api.ts` sets out: x86 costs
 * ~20% more per GB-second for identical work, and nodejs24 is a runtime nothing
 * in this repo has been tested against.
 */
export const embeddingWorker = new sst.aws.Function('EmbeddingWorker', {
  handler: 'apps/worker/src/embed.handler',

  architecture: 'arm64',
  runtime: 'nodejs22.x',

  /**
   * 1 GB, against the API's 512 MB.
   *
   * Lambda scales CPU with memory, and this function holds a 1,024-dimension
   * vector per message and serialises it into a bound parameter. More
   * importantly it is *not* latency-bound in the way the API is — nobody is
   * waiting on it — so the figure is chosen for throughput per invocation
   * rather than for time-to-first-byte.
   */
  memory: '1024 MB',

  timeout: WORKER_TIMEOUT,

  /**
   * In the VPC, because RDS lives in private subnets with no inbound path from
   * the internet.
   *
   * Bedrock does not: it is reached over the public internet, so this function
   * egresses through the VPC's NAT. **That is a NAT *instance*, not a gateway**
   * — `infra/vpc.ts` sets `nat: "ec2"` precisely to avoid the ~$32/month/AZ a
   * managed gateway costs (P0-12) — and it is already provisioned for Stripe,
   * Resend and domain verification, so Bedrock traffic adds no fixed cost at
   * all, only EC2 data-out.
   *
   * **A PrivateLink endpoint for Bedrock is not worth it and will not become
   * worth it**, which is worth stating as a number rather than left as "revisit
   * later" — because acting on that would cost real money for no return.
   *
   * At the ceiling this product is built for, ten tenants: 20,000 wines, three
   * full re-index passes over their lifetime, and ~2 KB of text per request
   * (the 1,024-float response is *inbound* and free) is **0.11 GB outbound in
   * total** — about one cent at $0.09/GB. An interface endpoint is ~$0.011/hour
   * per AZ, and RDS pins the VPC at two AZs, so ~$16/month. **$193 a year to
   * save a cent.**
   *
   * Revisit only if the volume changes by four orders of magnitude, which for
   * ten sellers it cannot.
   */
  vpc,

  environment: {
    DATABASE_URL: databaseUrl.value,
    NODE_ENV: 'production',
    SST_STAGE: $app.stage,
  },

  permissions: [
    ...parameterReadPermissions(['database/url']),
    {
      /*
       * Titan, and only Titan. A wildcard on `bedrock:InvokeModel` would let a
       * bug in this function invoke any model the account has access to,
       * including ones billed at fifty times the rate — and the bill is the
       * only place that would show up.
       */
      actions: ['bedrock:InvokeModel'],
      resources: [
        $interpolate`arn:aws:bedrock:${aws.getRegionOutput().name}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    },
  ],
});

/**
 * The event source mapping, and the one line this task exists to get right.
 *
 * **`MaximumConcurrency`, never reserved concurrency.** With an SQS source,
 * reserved concurrency does not slow polling — it throttles invocations. SQS
 * keeps delivering, throttled messages return to the queue, **each return
 * increments the receive count**, and past `maxReceiveCount: 3` they land in
 * the DLQ. The result is a DLQ full of perfectly valid products that were never
 * actually attempted, looking exactly like the embedding failures P1-50 exists
 * to triage.
 *
 * `MaximumConcurrency` caps how many concurrent invocations the mapping will
 * *attempt*: no throttling, no inflated receive counts, no spurious DLQ
 * entries. (The minimum AWS accepts is 2.)
 */
embeddingQueue.subscribe(embeddingWorker.arn, {
  transform: {
    eventSourceMapping: {
      batchSize: BATCH_SIZE,

      /**
       * **The setting that makes a batch of ten survive one bad message.**
       *
       * Without it, a handler that reports any failure fails the whole batch:
       * nine wines that embedded successfully are redelivered, re-embedded and
       * paid for again — and after three rounds all ten reach the DLQ. The
       * handler returns `batchItemFailures`; this is what makes Lambda read it.
       */
      functionResponseTypes: ['ReportBatchItemFailures'],

      scalingConfig: {
        maximumConcurrency: CONNECTIONS.workerConcurrency,
      },
    },
  },
});

/**
 * The poller (P1-31).
 *
 * Separate from the worker because it does a different job on a different
 * trigger: it reads `outbox` across every tenant and publishes, where the
 * worker consumes one tenant's message at a time. Sharing a function would mean
 * one set of permissions covering both, and the poller's scope is the one that
 * needs the least of them.
 */
const pollerFunction = {
  handler: 'apps/worker/src/outbox-poller.handler',

  architecture: 'arm64',
  runtime: 'nodejs22.x',
  memory: '512 MB',

  /**
   * Two minutes, well inside the one-minute schedule's tolerance.
   *
   * A pass claims 100 rows and sends ten SQS batches; twenty passes is the cap.
   * Overrunning is not a data-loss risk — the claim rolls back and the rows stay
   * claimable — but an invocation that never finishes would repeat that for
   * ever, so the ceiling is in `pollOutbox` as well as here.
   */
  timeout: '120 seconds',

  vpc,

  environment: {
    DATABASE_URL: databaseUrl.value,
    EMBEDDING_QUEUE_URL: embeddingQueue.url,
    NODE_ENV: 'production',
    SST_STAGE: $app.stage,
  },

  permissions: [
    ...parameterReadPermissions(['database/url']),
    {
      // Send only. The poller never receives from this queue and never deletes
      // from it — that is the worker's half, and a poller that could delete
      // could drain the queue without anything being embedded.
      actions: ['sqs:SendMessage', 'sqs:SendMessageBatch'],
      resources: [embeddingQueue.arn],
    },
  ],
} satisfies sst.aws.FunctionArgs;

/**
 * Every minute, on a schedule.
 *
 * **`sst.aws.Cron` rather than a bare `EventRule`**, and the difference is not
 * cosmetic: a rule on its own has no target and no invoke permission, so it
 * fires happily and calls nothing. The queue would then stay full while
 * CloudWatch showed a healthy rule with a hundred per cent success rate — the
 * failure mode this whole task exists to remove, reintroduced one level up.
 *
 * **The opportunistic invocation after a write is deliberately absent.** P1-31's
 * row mentions it, and the schedule is what makes it optional: if it never
 * fires nothing is lost, only delayed by up to a minute. Adding it costs the
 * API an `lambda:InvokeFunction` grant and a call on the write path that can
 * fail — paid on every product save, to remove a delay nobody has complained
 * about.
 */
export const outboxPoller = new sst.aws.Cron('OutboxPoller', {
  schedule: 'rate(1 minute)',
  function: pollerFunction,
});

/**
 * A DLQ with anything in it is an outage.
 *
 * **The alarm is the point of the DLQ, not a nicety on top of it.** A queue
 * that silently accumulates unprocessable messages is indistinguishable from a
 * queue with nothing to do — both are quiet — and the wines in it are simply
 * missing from every recommendation until somebody happens to look.
 *
 * `treatMissingData: notBreaching` because an empty DLQ publishes no
 * datapoints: without it the alarm sits in INSUFFICIENT_DATA for ever, which is
 * the state people learn to ignore.
 */
new aws.cloudwatch.MetricAlarm('EmbeddingDlqDepth', {
  alarmDescription:
    'Messages in the embedding dead-letter queue. Each one is a wine that will ' +
    'never be recommended until somebody looks (P1-32).',
  namespace: 'AWS/SQS',
  metricName: 'ApproximateNumberOfMessagesVisible',
  dimensions: { QueueName: embeddingDlq.nodes.queue.name },
  statistic: 'Maximum',
  period: 300,
  evaluationPeriods: 1,
  threshold: 0,
  comparisonOperator: 'GreaterThanThreshold',
  treatMissingData: 'notBreaching',
});
