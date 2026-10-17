# Alarms

Every alarm the stack creates, what it means when it fires, and what to do. One entry per alarm,
under the alarm's own name — the name in the email's subject. `infra/test/alarm-config.test.ts`
fails for an alarm with no entry here and for an entry with no alarm.

All of them go to one SNS topic (`sommelier-<stage>-alarms`) and from there to the address in the
`BudgetAlertEmail` secret, when they fire and again when they clear. The subscription has to be
confirmed from that inbox once per stage; until it is, alarms fire and nobody is told.

Start from the request id or the time. Logs are JSON and searchable by `requestId` and `tenantId`
in CloudWatch Logs Insights. Never fix one of these by raising its threshold first.

Forcing each one, once, in a review stage is the only test that it fires; how is at the end of each
entry.

## Api5xxRate

**Means:** more than a twentieth of API requests were answered 5xx over five minutes (at least
twenty requests).
**Do:** read the `Api` function's error logs for the window (`level` 50, `unhandled error`). A
deploy in the last hour is the first suspect — roll it back, then read. If every failure is a
database error, see `DatabaseConnections` and `DatabaseCpu`.
**Force it:** deploy a review stage with `DATABASE_URL` pointing nowhere and call any dashboard
route twenty times.

## ApiThrottles

**Means:** the API reached its reserved concurrency and refused a request before any code ran.
**Do:** traffic has outgrown the instance. Raise the database instance class and
`concurrency.reserved` together, and `CONNECTIONS.apiConcurrency` in `infra/queue-config.ts` with
them. Never the concurrency alone: each container holds database connections.
**Force it:** set `concurrency.reserved` to 1 in a review stage and send two slow requests at once.

## Chat5xxRate

**Means:** more than a twentieth of chat requests failed with a 5xx before the stream began. A
failure mid-stream is an `error` event to the widget and is not counted here.
**Do:** read the `Chat` function's error logs. Most often the session keys, the model provider's
permissions, or the database.
**Force it:** in a review stage, remove the function's `bedrock:InvokeModel` grant and ask a
question twenty times.

## ChatEscalationRate

**Means:** more than a tenth of chat turns in the hour went to the stronger model tier (at least
twenty turns).
**Do:** a few percent is the cheap tier doing its job; a climbing rate is the cheap tier failing.
Look at which reasons are escalating in the `widget chat turn` traces. The answer is the model
decision (Open Decision 1), not this threshold.
**Force it:** ask a review stage twenty questions that each name three constraints.

## ChatLatencyP95

**Means:** one chat turn in twenty took over twenty seconds, for a quarter of an hour.
**Do:** find a slow turn's trace (P7-01): `llm.generate` long is the provider, `rag.search` long is
the database, `rag.embed` long is the embedding model. Check the provider's status page before
changing anything.
**Force it:** point a review stage at a model alias with a low throughput quota and send a burst.

## ChatThrottles

**Means:** the chat function reached its reserved concurrency; a visitor asked a question and no
code ran.
**Do:** as `ApiThrottles` — the chat function shares the database with the API. Raise the instance
class and both caps together.
**Force it:** set the chat function's `concurrency.reserved` to 1 and open two chats at once.

## DatabaseConnections

**Means:** four fifths of the connections the instance accepts have been in use for a quarter of an
hour. The API and the worker are budgeted half between them.
**Do:** find who holds the rest: `select usename, application_name, state, count(*) from
pg_stat_activity group by 1, 2, 3`. Idle-in-transaction sessions are a leak in code; many `psql`
sessions are a person. Do not raise Lambda concurrency while this is firing.
**Force it:** open eighty-one connections to a review stage's database and hold them.

## DatabaseCpu

**Means:** the database has averaged over four fifths CPU for a quarter of an hour.
**Do:** Performance Insights, top SQL by load. A retrieval query without its index, or a rollup or
import running in business hours, are the usual ones. Raising the instance class is the answer only
after the query has been looked at.
**Force it:** run `select count(*) from generate_series(1, 2000000000)` against a review stage.

## EmbeddingDlqDepth

**Means:** there are messages in the embedding dead-letter queue. Each is a wine that failed to be
indexed three times and will not be recommended until somebody acts.
**Do:** follow `docs/runbooks/embedding-failures.md`. Fix the cause, then redrive with
`node scripts/redrive-dlq.mjs`.
**Force it:** send the review stage's embedding queue a message naming a product that does not
exist.

## EmbeddingQueueAge

**Means:** the oldest message waiting to be embedded has waited a quarter of an hour.
**Do:** the worker is not draining. Its error logs say whether the provider is throttling
(`ThrottlingException`: wait, or lower the batch size), whether every message is failing (the DLQ
alarm follows), or whether it is not running at all (the event source mapping is disabled).
**Force it:** disable the embedding worker's event source mapping in a review stage and edit a wine.

## QuotaRefusalSpike

**Means:** twenty or more messages in a quarter of an hour were turned away because a winery's
month is spent.
**Do:** find the winery — `select tenant_id, messages from usage_daily where day = current_date
order by messages desc limit 5` — and write to its owners. It has had the automatic 100% email
(P5-12); a person offering a top-up or the next plan the same afternoon is what this alarm is for.
**Force it:** set a review winery's month to its cap in `usage_events` and send twenty-one messages.

## RefusedOriginSpike

**Means:** over fifty widget requests in five minutes carried a real key from a site that key's
winery has not verified.
**Do:** `select tenant_id, origin, count(*) from security_events where type = 'UNAUTHORIZED_ORIGIN'
and created_at > now() - interval '1 hour' group by 1, 2 order by 3 desc`. A domain that looks like
the winery's own (a new shop address, a staging site) is a seller to help: they see the same site in
their dashboard and can add it. A domain that is nobody's is a copied snippet; the refusals are the
system working, and rotating the public key (P4-09) stops the noise.
**Force it:** load a review winery's snippet fifty-one times from a page on an unverified origin.

## RetentionPurgeSilent

**Means:** the retention purge reported no run for a day. Transcripts past their winery's period
are being kept, which §3.9 says they are not.
**Do:** if `ScheduledJobErrors` also fired, start there. Otherwise check the schedule is enabled
and that the job logged `retention.completed`. Nothing is lost by a missed night — the next run
takes everything past its cutoff — but a purge that stays stopped is a compliance problem that
grows by a day of transcripts every day. Invoke it by hand with `{ "dryRun": true }` first to see
what it would take.
**Force it:** disable the purge's schedule in a review stage for a day.

## ScheduledJobErrors

**Means:** a scheduled job threw: the sweep, the claim sweep, the usage rollup, the retention purge
or the outbox poller.
**Do:** the `Errors` metric per function says which; that function's log has the error. The outbox
poller failing means edited wines are not being queued for indexing — treat it first. The claim
sweep failing means domain-claim notices and transfers are late.
**Force it:** revoke a review stage's `database/url` parameter permission from one job and wait for
its schedule.

## SweepDeletedNothing

**Means:** the sweep deleted no rows for a day, or never reported.
**Do:** if `ScheduledJobErrors` also fired, start there. Otherwise check the schedule is enabled
and that the job logged `sweep.completed`. Lapsed token revocations and closed rate-limit windows
grow on every request until it runs again.
**Force it:** disable the sweep's schedule in a review stage for a day.

## TenantModelSpend

**Means:** one winery's model calls cost more than a dollar in a day — more than the largest plan's
whole month of messages should.
**Do:** find it: `select tenant_id, day, messages, cost_micros from usage_daily order by cost_micros
desc limit 5`. Many messages is a loop or abuse on that winery's widget: check `security_events` and
its rate limits. Few messages at a high cost is a wrong price in `packages/core/src/usage.ts` or the
stronger tier answering everything (`ChatEscalationRate`). The monthly cap bounds messages, not
cost; this is the only thing watching cost.
**Force it:** insert a `usage_events` row with `cost_micros` of 1500000 for a review winery and run
the rollup.

## UsageRollupSilent

**Means:** the nightly usage rollup reported no run for a day.
**Do:** if `ScheduledJobErrors` also fired, start there. `usage_daily` stops at the last night that
ran, and the dashboard's history with it; nothing is lost, because the rollup recomputes from the
ledger. Once fixed, the next night's run rewrites the last two days by itself; for a longer gap call
`rollup({ days })` from `apps/worker/src/rollup.ts` with the gap's length (up to 31).
**Force it:** disable the rollup's schedule in a review stage for a day.
