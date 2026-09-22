/// <reference path="../.sst/platform/config.d.ts" />

import process from 'node:process';

import {
  CHAT_ESCALATIONS_METRIC,
  CHAT_METRIC_NAMESPACE,
  CHAT_TURNS_METRIC,
  escalationRateExpression,
  ESCALATION_PERIOD_SECONDS,
  ESCALATION_RATE_THRESHOLD,
} from './chat-metrics';
import { authSecret, databaseUrl, originSecret, parameterReadPermissions } from './config';

/**
 * The public origin Better Auth builds absolute URLs against.
 *
 * A secret rather than a config value only because `sst.Secret` is the
 * mechanism this app already has for operator-supplied per-stage values; the
 * domain itself is not sensitive.
 */
const authBaseUrl = new sst.Secret('AuthBaseUrl', 'https://localhost');

/**
 * The transactional email provider key (P0-64).
 *
 * **Defaulted to the empty string on purpose.** A secret with no default makes
 * `sst deploy` fail until somebody sets it, and the sending domain is not
 * authenticated yet (E6) — so requiring it would block every deploy on work
 * that has nothing to do with deploying. Empty is read as absent by the
 * composition root, which then uses the log transport: the message is rendered
 * in full to CloudWatch instead of being sent.
 *
 * Set it, when the domain is ready, from stdin rather than as an argument so
 * the value never reaches a shell history file:
 *   `sst secret set ResendApiKey --stage <stage>`
 */
const resendApiKey = new sst.Secret('ResendApiKey', '');

/**
 * The `From` header. Its domain must be the authenticated one (E6).
 *
 * A secret for the same reason `AuthBaseUrl` is one — not because an address is
 * sensitive, but because `sst.Secret` is the mechanism this app already has for
 * an operator-supplied per-stage value.
 */
const emailFrom = new sst.Secret('EmailFrom', 'AI Sommelier <noreply@localhost>');

/**
 * Addresses a non-production stage may really mail, comma-separated.
 *
 * Empty by default, which means a non-production stage can mail **nobody** —
 * every message goes to the log. That is the safe direction: the list is how
 * you deliberately let one address through for manual testing, never how you
 * accidentally reach a customer.
 */
const emailAllowlist = new sst.Secret('EmailAllowlist', '');

/**
 * The Resend webhook endpoint signing secret, `whsec_…` (P0-64b).
 *
 * Empty by default, on the same terms as `ResendApiKey` and for the same
 * reason: creating the endpoint in Resend's dashboard is operator work, and a
 * secret with no default would block every deploy on it. Empty reads as absent,
 * and the endpoint then refuses every delivery — restrictive rather than
 * permissive, so an unset value costs recorded bounces (E7) and exposes
 * nothing.
 *
 * Set it from stdin so the value never reaches a shell history file:
 *   `sst secret set ResendWebhookSecret --stage <stage>`
 */
const resendWebhookSecret = new sst.Secret('ResendWebhookSecret', '');

/**
 * The widget session token keyset (P2-11): one or two Ed25519 private JWKs, the
 * first of which signs.
 *
 * **An `sst.Secret`, which SST keeps as an SSM `SecureString`** — where §5.7 puts
 * the key, through the mechanism every other operator-supplied value here uses.
 * One value holding both active keys rather than a parameter per `kid`, so a
 * rotation is a single write and there is never a moment when the new signing
 * key is set and its predecessor has already gone.
 *
 * Empty by default, like the email secrets: nothing reads it until P2-12 mints
 * tokens, and a secret with no default would block every deploy on it. Generate
 * it and set it through a pipe, so the key never touches a file or a history:
 *   `node scripts/widget-token-key.mjs | sst secret set WidgetTokenKeys --stage <stage>`
 */
const widgetTokenKeys = new sst.Secret('WidgetTokenKeys', '');
import { vpc } from './vpc';

/**
 * What both functions read from the environment (P2-29).
 *
 * One object, because the buffered function and the streaming one run the same
 * composition root and would fail in the same way on a missing variable — and a
 * second copy is how one of them comes to be missing a value the other has.
 */
const environment = {
  /**
   * The commit this bundle was built from, surfaced by `/v1/health`.
   *
   * Read from the CI environment at synth time, since neither SST nor Pulumi
   * knows about git. Empty on a local `sst deploy`, which the health endpoint
   * reports as `unknown` rather than failing — see `apps/api/src/app.ts`.
   */
  BUILD_SHA: process.env.GITHUB_SHA ?? '',

  /**
   * `NODE_ENV=production`, and it is load-bearing for security rather than
   * for bundle size (P0-46).
   *
   * **AWS Lambda does not set `NODE_ENV`.** Better Auth reads it with a
   * default of `'development'`, and two of its behaviours hang off that:
   *
   * 1. Rate limiting resolves to `enabled: ?? isProduction`, so every auth
   *    endpoint would have been unlimited. `packages/core` now sets
   *    `enabled: true` explicitly, so this is belt and braces there.
   * 2. `getIP` falls back to `127.0.0.1` for *every* request in development,
   *    which is the dangerous one: with limiting on and all callers sharing
   *    one bucket, a single attacker exhausting the sign-in limit locks out
   *    every user. The limiter becomes a denial of service.
   *
   * Nothing about either would have looked wrong in a deployment.
   */
  NODE_ENV: 'production',

  /**
   * Read from SSM at synth time and injected, rather than fetched per cold
   * start.
   *
   * `GetParameter` is free but not instant, and a Lambda that fetches two
   * parameters before it can answer anything pays that latency on every cold
   * start across every container. The trade is that rotating either value
   * needs a deploy — acceptable, since rotating the auth secret invalidates
   * every session anyway and is never a quiet operation.
   */
  DATABASE_URL: databaseUrl.value,
  AUTH_SECRET: authSecret.value,

  /**
   * What Better Auth builds password-reset and OAuth callback URLs against.
   *
   * **An operator-set secret, and it has to be** *(P0-17a finding).* The
   * obvious value is the CloudFront domain — a reset link pointing at the raw
   * Function URL would bypass the edge and break the moment the origin moved.
   * But reading `distribution.domainName` here creates a **circular
   * dependency**: CloudFront needs this function's URL as an origin, and this
   * function would need CloudFront's domain. Neither can be created first.
   *
   * That cycle is inherent to the topology rather than an artefact of how it
   * is written, so it is broken deliberately: the value is supplied out of
   * band, exactly as `BudgetAlertEmail` is.
   *
   * Set it once per stage, after the first deploy tells you the domain:
   *   `sst secret set AuthBaseUrl https://d111111abcdef8.cloudfront.net`
   * It becomes a constant the day a custom domain exists, at which point this
   * stops being a manual step at all.
   */
  AUTH_BASE_URL: authBaseUrl.value,

  /**
   * The stage, which decides whether mail is sent or logged (P0-64).
   *
   * Injected explicitly rather than relied upon: Lambda does not set it, and
   * the composition root defaults an absent value to `unknown` — which routes
   * to the log transport. So a missing variable here degrades to "logs the
   * mail" rather than to "mails the customer", and this line is what makes
   * the *intended* behaviour happen rather than the safe fallback.
   */
  SST_STAGE: $app.stage,

  /**
   * The shared secret CloudFront attaches to origin requests (A2).
   *
   * The API refuses any request arriving without it, so this is what stops a
   * caller reaching the Function URL directly and forging `X-Forwarded-For`
   * around the edge. `src/index.ts` refuses to start a deployed stage if it
   * is absent, because absent is *permissive* here and a container that comes
   * up healthy while quietly reachable is the failure this closes.
   */
  ORIGIN_SECRET: originSecret,

  EMAIL_FROM: emailFrom.value,
  RESEND_API_KEY: resendApiKey.value,
  EMAIL_ALLOWLIST: emailAllowlist.value,

  /**
   * Verifies inbound Resend delivery events (P0-64b).
   *
   * Absent is restrictive here — the endpoint refuses everything — so unlike
   * `ORIGIN_SECRET` the API starts without it and logs a warning instead. The
   * cost of forgetting it is silent in exactly the way E7 describes: an empty
   * suppression list is indistinguishable from a domain with no bounces.
   */
  RESEND_WEBHOOK_SECRET: resendWebhookSecret.value,

  /**
   * The widget token keyset (P2-11), read once per container when P2-12's
   * session route loads its keys — injected like `AUTH_SECRET`, for the same
   * cold-start reason.
   */
  WIDGET_TOKEN_KEYS: widgetTokenKeys.value,
};

/**
 * The API Lambda and its Function URL (P0-54).
 *
 * One function serves both route surfaces (§5.1) — the split between
 * `/v1/dashboard/*` and `/v1/widget/*` is by route group inside Hono, not by
 * deployment. `/v1/widget/chat` is the single exception and gets its own
 * `RESPONSE_STREAM` function in P2-29, because invoke mode is a property of the
 * function rather than of the route.
 *
 * **Every option below is set explicitly, and three of them differ from SST's
 * default.** Verified against the pinned v4.17.1 source rather than the docs,
 * as `sst.config.ts` requires:
 *
 * | Option         | SST default (`function.ts`)         | Here      |
 * |----------------|-------------------------------------|-----------|
 * | `architecture` | `"x86_64"` (line 1769)              | `arm64`   |
 * | `runtime`      | `"nodejs24.x"` (line 1844)          | `nodejs22`|
 * | `memory`       | `"1024 MB"` (line 1888)             | `512 MB`  |
 *
 * Each of those defaults would have been wrong quietly. `x86_64` costs ~20%
 * more per GB-second for identical work; `1024 MB` doubles the figure every
 * cost projection in §5.2a is built from; and `nodejs24.x` would have run the
 * application on a runtime nothing in this repo has been tested against — the
 * `.nvmrc`, CI and every local run are all Node 22.
 */
export const api = new sst.aws.Function('Api', {
  handler: 'apps/api/src/index.handler',

  // Direct Function URL. CloudFront gains it as an origin in P0-17a, which
  // needs an origin to point at and is why that task waited for this one.
  url: true,

  architecture: 'arm64',
  runtime: 'nodejs22.x',
  memory: '512 MB',

  /**
   * Reserved concurrency, capped at 10 (P1-48, closing B1).
   *
   * **The plan contradicts itself and P1-48 is the half that is right.** §5.1
   * says 40; each concurrent Lambda holds a Postgres connection, and forty
   * against a `t4g.micro` exhausts `max_connections` before the function is
   * anywhere near its own limit — so the database falls over first and the
   * symptom looks like an application fault.
   *
   * Unset was never a third option, only an unnoticed one: an unbounded
   * function against that instance is worse than either figure, and it was safe
   * until now purely because nothing was deployed.
   *
   * **It interacts with A1 and the two must move together.** Better Auth's
   * limits are per container, so raising this multiplies every configured
   * limit by the number of warm containers. That is now backed by
   * `rate_limit_buckets` through the P2-01 limiter, which makes the counters
   * shared — but the coupling remains the reason to revisit both at once rather
   * than either alone.
   *
   * Reserved rather than provisioned: reserved caps and costs nothing,
   * provisioned pre-warms and bills continuously.
   */
  concurrency: { reserved: 10 },

  /**
   * BUFFERED, stated rather than inherited.
   *
   * `streaming: false` resolves to `invokeMode: "BUFFERED"` (function.ts:2744).
   * It is already the default, and it is written down anyway: flipping a
   * function to `RESPONSE_STREAM` changes the response envelope for *every*
   * route it serves and needs a different CloudFront cache behaviour to survive
   * the edge (P0-17a). A silent default change would surface as "the API
   * returns nothing", far from the line that caused it.
   *
   * Either mode caps a request at 6 MB, refused before the handler runs and
   * with an answer that names no limit. The import's own request cap sits
   * under it so the refusal a seller reads is ours (P1-27).
   */
  streaming: false,

  /**
   * 10 seconds, well under SST's 20-second default.
   *
   * **Restated as `API_TIMEOUT_SECONDS` in `packages/core`**, which the import's
   * time budget and claim expiry are sized from. `apps/api/test/import-time-budget.test.ts`
   * reads this line and fails if the two disagree, so change both together.
   *
   * Nothing on this function talks to a model — the endpoint that does is the
   * streaming one in P2-29, with its own timeout. What a long timeout buys here
   * is a request that has already failed continuing to bill, and a caller
   * holding a socket open on a database call that is never coming back.
   */
  timeout: '10 seconds',

  /**
   * In the VPC, because P0-45 is the first task whose code opens a connection.
   *
   * RDS lives in private subnets with no inbound path from the internet, so a
   * function outside the VPC simply cannot reach it. The cost is cold-start
   * latency for ENI attachment — real, but nothing here is optional: the API
   * without a database is an API that can serve `/v1/health` and nothing else.
   */
  vpc,

  environment,

  /**
   * Only the two parameters this function actually reads.
   *
   * `parameterReadPermissions` refuses the deploy-time paths outright, so a
   * mistake here stops the deploy rather than appearing in a diff someone
   * skims — see P0-15. One wildcard `ssm:GetParameter` would mean a bug in the
   * widget path yields every secret in the account.
   */
  permissions: [
    ...parameterReadPermissions(['database/url', 'auth/secret']),
    {
      /*
       * Titan, and only Titan (P2-37). This function embeds a query for the
       * retrieval sandbox, and will embed a visitor's question for P2-29. The
       * grant is the worker's, written out again rather than shared: a wildcard
       * on `bedrock:InvokeModel` would let a bug here invoke any model the
       * account can reach, including ones billed at fifty times the rate, and
       * the bill is the only place that would show up.
       */
      actions: ['bedrock:InvokeModel'],
      resources: [
        $interpolate`arn:aws:bedrock:${aws.getRegionOutput().name}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    },
  ],
});

/**
 * Throttles on the API: the reserved-concurrency cap being hit (P1-48).
 *
 * **The cap is only safe if hitting it is visible.** A throttled invocation is
 * refused before the handler runs, so it writes no log line of ours and raises
 * no error we could catch; the caller sees a failure, and without this alarm
 * the only record is a metric nobody is looking at. Ten is sized to the
 * `t4g.micro`'s connections, so this firing means traffic has outgrown the
 * instance: raise the instance class and `concurrency.reserved` together, and
 * `CONNECTIONS.apiConcurrency` in `queue-config.ts` with them.
 *
 * Any throttle at all over five minutes, because at this scale one refused
 * request is already worth knowing about. `treatMissingData: notBreaching` for
 * the DLQ alarm's reason: a function that is never throttled publishes no
 * datapoints, and an alarm left in INSUFFICIENT_DATA is one people learn to
 * ignore. No action yet — routing and the runbook entry are P7-02's.
 */
new aws.cloudwatch.MetricAlarm('ApiThrottles', {
  alarmDescription:
    'The API is refusing requests at its reserved concurrency (P1-48). Raise the ' +
    'database instance class and the concurrency together, never the concurrency alone.',
  namespace: 'AWS/Lambda',
  metricName: 'Throttles',
  dimensions: { FunctionName: api.name },
  statistic: 'Sum',
  period: 300,
  evaluationPeriods: 1,
  threshold: 0,
  comparisonOperator: 'GreaterThanThreshold',
  treatMissingData: 'notBreaching',
});

/**
 * The streaming function (P2-29, §5.1).
 *
 * **A second function over the same app, and that is the whole difference.**
 * `RESPONSE_STREAM` is a property of the function rather than of a route: a
 * Lambda either streams or it does not, and every route but chat answers with a
 * small JSON body that streaming would cost a warm connection to deliver. So
 * the chat path gets its own function, its own Function URL and its own
 * CloudFront origin, and `apps/api/src/streaming.ts` is the entry it runs —
 * one line different from the buffered one, over the same composition root.
 *
 * **Sixty seconds, not ten.** The buffered function's timeout is sized to a
 * request that either answers quickly or has gone wrong; a generated answer
 * legitimately takes five to eight seconds and an escalated one longer, and the
 * cost of a low ceiling here is a visitor watching a reply stop mid-sentence.
 * Sixty is also what the CloudFront origin behind it allows without a quota
 * increase, so a longer timeout here would be a promise the edge would break.
 *
 * **The same concurrency budget applies and is spent separately.** Each
 * concurrent invocation holds a Postgres connection, so this function's reserve
 * is subtracted from the same `max_connections` P1-48 sized — five and ten,
 * against a pool that tolerates both.
 */
export const chat = new sst.aws.Function('Chat', {
  handler: 'apps/api/src/streaming.handler',
  url: true,

  architecture: 'arm64',
  runtime: 'nodejs22.x',
  memory: '512 MB',

  /** RESPONSE_STREAM, which is the one reason this function exists. */
  streaming: true,

  timeout: '60 seconds',

  /*
   * Half the buffered function's reserve, out of the same connection budget.
   * Chat is the expensive path and the one a burst would hit, so it is capped
   * rather than left to compete for whatever the API is not using.
   */
  concurrency: { reserved: 5 },

  vpc,

  environment,

  permissions: [
    ...parameterReadPermissions(['database/url', 'auth/secret']),
    {
      /* Titan for the query embedding, Nova for the answer, and nothing else. */
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        $interpolate`arn:aws:bedrock:${aws.getRegionOutput().name}::foundation-model/amazon.titan-embed-text-v2:0`,
        $interpolate`arn:aws:bedrock:${aws.getRegionOutput().name}::foundation-model/amazon.nova-lite-v1:0`,
        $interpolate`arn:aws:bedrock:${aws.getRegionOutput().name}::foundation-model/amazon.nova-2-lite-v1:0`,
      ],
    },
  ],
});

/**
 * Everything the function needs is set on it above: reserved concurrency
 * (P1-48, B1), and VPC placement with its SSM grants (P0-45).
 */
export const apiUrl = api.url;

/** The streaming origin CloudFront points `/v1/widget/chat` at (P0-17a, P2-29). */
export const chatUrl = chat.url;

/**
 * The escalation rate (P2-28), and the open item it closes.
 *
 * **A rate, not a count, and that is the whole reason this waited.** P2-28
 * emits every escalation the moment it decides one; a count of those alarms on
 * a busy Saturday, which is the opposite of what the row wants. The denominator
 * — turns — arrived with P2-29 and P2-31, and both numbers now come out of one
 * EMF line the chat route writes.
 *
 * **`notBreaching` on missing data**, because the expression deliberately
 * returns nothing under `ESCALATION_MIN_TURNS`: a rate over two turns is a
 * statistic about nothing, and an alarm that fired on it would be one people
 * learn to ignore — which is the failure `EmbeddingDlqDepth` avoids the other
 * way round.
 *
 * No action yet; routing and the runbook entry are P7-02's, as with the others.
 */
new aws.cloudwatch.MetricAlarm('ChatEscalationRate', {
  alarmDescription:
    'More than a tenth of chat turns are escalating to the stronger tier (P2-28). A few ' +
    'percent is the cheap tier doing its job; a climbing rate is the cheap tier failing, and ' +
    'the answer is to revisit §Open Decision 1 rather than to raise this threshold.',
  comparisonOperator: 'GreaterThanThreshold',
  evaluationPeriods: 1,
  threshold: ESCALATION_RATE_THRESHOLD,
  treatMissingData: 'notBreaching',

  metricQueries: [
    {
      id: 'rate',
      expression: escalationRateExpression(),
      label: 'Escalation rate',
      returnData: true,
    },
    {
      id: 't',
      metric: {
        namespace: CHAT_METRIC_NAMESPACE,
        metricName: CHAT_TURNS_METRIC,
        dimensions: { Stage: $app.stage },
        stat: 'Sum',
        period: ESCALATION_PERIOD_SECONDS,
      },
    },
    {
      id: 'e',
      metric: {
        namespace: CHAT_METRIC_NAMESPACE,
        metricName: CHAT_ESCALATIONS_METRIC,
        dimensions: { Stage: $app.stage },
        stat: 'Sum',
        period: ESCALATION_PERIOD_SECONDS,
      },
    },
  ],
});
