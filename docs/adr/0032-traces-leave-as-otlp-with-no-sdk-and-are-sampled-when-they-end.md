# 0032. Traces leave as OTLP, with no SDK in the bundle, and are sampled when they end

Status: Accepted
Date: 2026-10-12

## Context

P7-01 asks for tracing: where a request's time went, with the winery, the session and the request
on every span, sampled at "10%, plus 100% of errors and slow requests", and nothing a person typed
in any attribute. The row says "OTel SDK in the Lambda handlers, exporting to CloudWatch or a
vendor".

Three things about this service shape the answer.

**The functions are Lambdas with a visitor waiting.** The chat function's whole latency budget is
somebody watching a widget. Anything loaded at cold start is paid for there, and an export still in
flight when the handler returns is frozen with the container and, as often as not, never sent.

**"100% of errors and slow requests" cannot be decided at the start of a request.** Whether it
failed or was slow is known when it is over. The SDK's samplers decide at the root span's start;
keeping every error means either exporting everything to a collector that samples at the tail —
which is the cost the row says to avoid — or holding a trace's spans until it ends.

**The chat response is a stream.** Its handler returns when the stream begins. The root span ends
then; the turn — the retrieval, the model, the bill — happens afterwards, inside the response.

And one thing is not ours to settle in code: where traces go. The AWS collector beside the function
keeps them in the account. A vendor's endpoint makes that vendor a processor of data that carries
winery and session identifiers.

## Decision

**What leaves is OpenTelemetry's wire format, OTLP/HTTP JSON. What produces it is one file,
`apps/api/src/telemetry.ts`, with no dependency.** The surface used is small — a span has a parent,
a start, an end and a handful of attributes — and the repository already makes this trade for
Stripe, Resend and Shopify: a small client over `fetch` instead of an SDK. The spans are named and
placed by the code that does the work (`withSpan`, `openSpan`), so adopting the SDK later is a
change to that file and to nothing that calls it.

**Off unless there is somewhere to send it.** With no exporter no trace is begun and every helper
is a plain call to the function it wraps. `OTEL_EXPORTER_OTLP_ENDPOINT` and
`OTEL_EXPORTER_OTLP_HEADERS` — OpenTelemetry's own names — turn it on. No deployment sets them
today; which endpoint to set is the operator's decision and is recorded as open in the plan.

**Sampled when the trace ends.** A trace's spans are held in memory until it is over, then sent or
dropped whole: kept if anything raised that was not an expected refusal, if the response was a 5xx,
if it lasted at least eight seconds from its first span's start to its last one's end, and
otherwise one time in ten. A `DomainError` and anything else that answers below 500 — a 404, a
spent month — is the system working and does not keep a trace by itself. The decision is made once;
a span that arrives afterwards follows it.

**A trace is over when its root has ended and nothing in it is still open**, which is what lets a
stream's trace outlive its handler. The chat route wraps the turn in a span begun as the stream
begins, and waits for the export itself after it has written `done` — the visitor has their answer,
and the response is still open, so the function is not frozen with the export in flight. A buffered
response waits for its own export, bounded by a one-second timeout, and only when its trace was
kept.

**What a span may say is a closed list.** `SPAN_ATTRIBUTES` names every attribute; a value must be
a number, a flag, or a string of at most 96 characters with no whitespace and no `@` — the shape of
an identifier, a model's name or a route's template, and of nothing a person types. An error
contributes its type's name and never its message. The request id, the winery and the session are
stamped on every span as it leaves, so a span begun before the winery was resolved carries it too.

## Consequences

- **No new dependency, and nothing added to a cold start** beyond one small module. The dependency
  audit has no tracing tree to watch.
- **We own the encoder.** OTLP/JSON for traces is small and stable, and the test asserts the body
  field by field; a change to the protocol is ours to follow.
- **No automatic instrumentation.** A database call is traced where somebody wrapped it — the chat
  path's reads and writes, retrieval, the model. A route nobody has instrumented is one root span.
  This is the cost most likely to be felt: the day an unexplained slow request is on the dashboard's
  side, the span that would explain it has to be added first.
- **No context is propagated outwards.** Nothing downstream of this service speaks OpenTelemetry
  today (Bedrock, Postgres, Stripe); when something does, `traceparent` has to be written by hand.
- **Spans are held in memory for the length of a request.** A chat turn is under a dozen. A trace
  that is dropped costs what it took to record it.
- **A kept trace on a buffered route adds its export to the response time**, at most a second and
  in practice a call to a collector on localhost. One request in ten, and every failed one.
- **The eight-second line is a guess** made before any production traffic, and is a parameter.
- **Until an endpoint is chosen, none of this runs.** The code is exercised by its tests and by
  nothing else.

## Alternatives rejected

- **The OpenTelemetry SDK with its OTLP exporter.** The conventional choice, and the one to return
  to if the instrumented surface grows. Rejected now for what it costs here against what it would
  be used for: a tree of packages on the cold start of the function whose latency a visitor watches,
  a head sampler that cannot do what the row asks, and a batch processor whose flush has to be
  forced before every freeze — to produce the same dozen spans.
- **The AWS Distro for OpenTelemetry layer with auto-instrumentation.** Hundreds of milliseconds on
  every cold start, a second runtime's worth of configuration, and spans for every HTTP call the SDK
  makes rather than for the five things worth timing.
- **Export everything and sample at a collector.** Exactly the cost the row tells us to avoid, and
  it sends every span of every request out of the process before anything decides it is not needed.
- **Head sampling at 10%, plus a log line for errors.** Simple, and it keeps one failed request in
  ten — the nine that mattered are the ones not kept.
- **Structured log lines instead of spans.** The request log already says how long a request took.
  It does not say where, and reassembling a tree from log lines is building a tracing backend.
- **A list of forbidden attribute names** rather than an allowed one. P0-56 made this choice for
  logs, for the same reason: the next attribute somebody adds is unlisted, and an unlisted name must
  be dropped rather than sent.
