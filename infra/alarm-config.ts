import { CONNECTIONS, type ConnectionBudget } from './queue-config';

/**
 * What the alarms watch, and where each line is drawn (P7-02).
 *
 * **Pure, like `chat-metrics.ts` and for its reason**: `alarms.ts` creates
 * resources at import and cannot be loaded by a test, so every number and
 * every name a test can hold to account lives here.
 *
 * Each threshold says why it is where it is. An alarm nobody can explain is one
 * somebody will raise the threshold of until it stops firing.
 */

/**
 * Every alarm this stack creates, by its logical name.
 *
 * **The list is what the runbook is checked against** (`docs/runbooks/alarms.md`):
 * an alarm with no entry there is a page that says something is wrong and not
 * what to do, and an entry with no alarm is advice about nothing.
 */
export const ALARMS = [
  'Api5xxRate',
  'ApiThrottles',
  'Chat5xxRate',
  'ChatEscalationRate',
  'ChatLatencyP95',
  'ChatThrottles',
  'DatabaseConnections',
  'DatabaseCpu',
  'EmbeddingDlqDepth',
  'EmbeddingQueueAge',
  'QuotaRefusalSpike',
  'RefusedOriginSpike',
  'ScheduledJobErrors',
  'SweepDeletedNothing',
  'TenantModelSpend',
  'UsageRollupSilent',
] as const;

export type AlarmName = (typeof ALARMS)[number];

/* ------------------------------------------------------------ what the app and the worker write */

/** A contract with `apps/api/src/metrics.ts`, held together by `test/alarm-config.test.ts`. */
export const WIDGET_METRIC_NAMESPACE = 'Catalogorosso/Widget';
export const REFUSED_ORIGINS_METRIC = 'RefusedOrigins';
export const QUOTA_REFUSALS_METRIC = 'QuotaRefusals';

/** A contract with `apps/worker/src/rollup.ts`, in `rollup-config.ts`'s namespace. */
export const TENANT_COST_METRIC = 'MaxTenantCostMicros';

/* ------------------------------------------------------------ errors */

/**
 * A twentieth of requests answered 5xx, over five minutes.
 *
 * A rate and not a count, for `ChatEscalationRate`'s reason: a count alarms on
 * a busy hour. The floor is what keeps one failure out of three requests at
 * four in the morning from being a 33% error rate.
 */
export const ERROR_RATE_THRESHOLD = 0.05;
export const ERROR_RATE_MIN_REQUESTS = 20;
export const ERROR_RATE_PERIOD_SECONDS = 300;

/** Nothing below the floor, so the alarm has no datapoint and stays as it was. */
export const errorRateExpression = (
  requests = 'r',
  errors = 'e',
  minimum = ERROR_RATE_MIN_REQUESTS,
): string => `IF(${requests} >= ${String(minimum)}, ${errors} / ${requests})`;

/* ------------------------------------------------------------ the chat function */

/**
 * A chat turn is a model writing a paragraph: seconds, when nothing is wrong.
 * One in twenty past twenty seconds, for a quarter of an hour, is a visitor
 * watching a widget think — the provider is slow, or retrieval is.
 */
export const CHAT_P95_MS = 20_000;
export const CHAT_P95_PERIOD_SECONDS = 300;
export const CHAT_P95_PERIODS = 3;

/* ------------------------------------------------------------ the widget's guards */

/**
 * Fifty requests in five minutes for a real key from a site its winery has not
 * verified. One visitor's page loads a handful; fifty is a copied snippet with
 * traffic behind it, or a seller who moved their shop and did not tell us.
 */
export const REFUSED_ORIGINS_THRESHOLD = 50;
export const REFUSED_ORIGINS_PERIOD_SECONDS = 300;

/**
 * Twenty messages turned away in a quarter of an hour because a month was
 * spent. The winery has already been told by email at 100% (P5-12); this is us
 * finding out that shoppers are being refused in numbers, while there is still
 * an afternoon in which to offer a top-up.
 */
export const QUOTA_REFUSALS_THRESHOLD = 20;
export const QUOTA_REFUSALS_PERIOD_SECONDS = 900;

/* ------------------------------------------------------------ the queue */

/**
 * The oldest message waiting to be embedded. The poller runs every minute and
 * a batch takes seconds, so a quarter of an hour is the worker not draining:
 * throttled by the provider, failing and retrying, or not running.
 */
export const QUEUE_AGE_SECONDS = 900;
export const QUEUE_AGE_PERIOD_SECONDS = 300;
export const QUEUE_AGE_PERIODS = 2;

/* ------------------------------------------------------------ the bill */

/**
 * One winery's models costing a dollar in a day.
 *
 * At the default tier a message costs around a hundredth of a cent, so a dollar
 * is some ten thousand messages — more in a day than the largest plan sells in
 * a month. Nothing a real shop does reaches it: it is a loop, a price entered
 * wrongly, or the stronger tier answering everything. The monthly cap (P2-36)
 * stops a winery's *messages*; this is what notices their *cost*.
 */
export const TENANT_DAILY_COST_MICROS = 1_000_000;
export const TENANT_COST_PERIOD_SECONDS = 86_400;

/* ------------------------------------------------------------ the database */

/** Four fifths, for a quarter of an hour: a burst is not an alarm, a plateau is. */
export const DATABASE_CPU_PERCENT = 80;
export const DATABASE_PERIOD_SECONDS = 300;
export const DATABASE_PERIODS = 3;

/**
 * Four fifths of what the instance will accept.
 *
 * The API and the worker together are budgeted half of it (`queue-config.ts`),
 * and the rest is migrations, the scheduled jobs and a person with `psql`. At
 * four fifths something is holding connections it should not, and the next
 * thing to be refused one is a request.
 */
export const databaseConnectionsThreshold = (budget: ConnectionBudget = CONNECTIONS): number =>
  Math.floor(budget.instanceMax * 0.8);

/* ------------------------------------------------------------ the scheduled jobs */

/** Any run that threw, in the hour. A job that fails every night is found the first night. */
export const SCHEDULED_ERRORS_PERIOD_SECONDS = 3600;

/** `e0 + e1 + …` for as many functions as are watched. */
export const sumExpression = (count: number): string =>
  Array.from({ length: count }, (_, index) => `e${String(index)}`).join(' + ');
