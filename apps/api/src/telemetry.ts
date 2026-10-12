import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

import { getRequestContext, isDomainError } from '@catalogorosso/core';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

import type { AppEnv } from './env.js';
import { logger } from './middleware/logger.js';

/**
 * Tracing (P7-01): where a request's time went, by winery and by session.
 *
 * **OpenTelemetry on the wire, and no SDK in the bundle.** What leaves is
 * OTLP/HTTP JSON, which the AWS collector and every vendor accept; what makes
 * it is this file. The reason is the one `stripe.ts` gives for having no Stripe
 * SDK: the surface used is small — spans with a parent, a start and an end —
 * and the SDK's weight is paid on every cold start of a function whose whole
 * budget is a visitor waiting. The spans are named and placed the same either
 * way, so adopting the SDK later is this file and nothing else.
 *
 * **Off unless there is somewhere to send it.** With no exporter no trace is
 * ever begun, and every helper below is a plain call to the function it wraps.
 *
 * **Sampled at the end, not the start** (§P7-01: "10%, plus 100% of errors and
 * slow requests"). Whether a request failed or was slow is known only when it
 * is over, so a trace's spans are held until then and sent or dropped whole.
 *
 * **What a span may say is a closed list** — `SPAN_ATTRIBUTES` — and a value
 * that looks like prose or an address is dropped whatever its key. A question
 * a shopper typed never reaches here; this is what makes that true of the
 * question somebody passes by mistake next year.
 */

/** Every attribute a span may carry. Adding a name here is a decision about what leaves the building. */
export const SPAN_ATTRIBUTES = [
  'http.method',
  'http.route',
  'http.status_code',
  'request_id',
  'tenant_id',
  'session_id',
  'error.type',
  'rag.model',
  'rag.vector_hits',
  'rag.lexical_hits',
  'rag.fused',
  'rag.candidates',
  'llm.model',
  'llm.tier',
  'llm.input_tokens',
  'llm.output_tokens',
  'llm.outcome',
  'chat.sandbox',
] as const;

export type SpanAttribute = (typeof SPAN_ATTRIBUTES)[number];
export type SpanValue = string | number | boolean;
export type SpanAttributes = Partial<Record<SpanAttribute, SpanValue | null | undefined>>;

const ALLOWED: ReadonlySet<string> = new Set(SPAN_ATTRIBUTES);

/**
 * An identifier, a model's name, a route's template — never a sentence and
 * never an address. Whitespace is what prose has and an `@` is what an email
 * has, and no value this file is meant to carry has either.
 */
const MAX_VALUE_LENGTH = 96;
const UNSAFE = /[\s@]/u;

/** The attributes that may leave: named on the list, and shaped like an identifier or a number. */
export const safeAttributes = (attributes: SpanAttributes): Record<string, SpanValue> => {
  const safe: Record<string, SpanValue> = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED.has(key) || value === null || value === undefined) continue;

    if (typeof value === 'string') {
      if (value === '' || value.length > MAX_VALUE_LENGTH || UNSAFE.test(value)) continue;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
    } else if (typeof value !== 'boolean') {
      continue;
    }

    safe[key] = value;
  }

  return safe;
};

interface SpanRecord {
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: 'server' | 'internal';
  readonly startMs: number;
  endMs: number | undefined;
  attributes: Record<string, SpanValue>;
  error: boolean;
}

interface Trace {
  readonly traceId: string;
  readonly spans: SpanRecord[];
  /** Spans begun and not yet ended. The trace is over when this is nought. */
  open: number;
  /** Something raised that was not an expected refusal, or the response was a 5xx. */
  error: boolean;
  /** Stamped on every span as it leaves: a child begun before the winery was known has it too. */
  ids: Record<string, SpanValue>;
  /** Decided once, when the trace is first over; a straggler follows the same decision. */
  sampled: boolean | undefined;
  /** How many spans have already been sent or dropped. */
  settled: number;
  readonly owner: Recorder;
}

interface Recorder {
  readonly settle: (trace: Trace) => void;
  readonly now: () => number;
  readonly flush: () => Promise<void>;
}

const storage = new AsyncLocalStorage<{ readonly trace: Trace; readonly spanId: string }>();

/** A span somebody ends by hand, because a generator cannot be wrapped in a callback. */
export interface OpenSpan {
  readonly set: (attributes: SpanAttributes) => void;
  /** Ends it. `error` marks the span, and the trace unless the failure was an expected refusal. */
  readonly end: (error?: unknown) => void;
}

const NOT_TRACING: OpenSpan = { set: () => undefined, end: () => undefined };

/**
 * A refusal is the system working (P0-55's rule for log levels, and the same
 * here): a 404, a spent month, a rate limit. Only what nobody expected makes a
 * trace worth keeping for its own sake.
 */
const unexpected = (error: unknown): boolean => {
  if (isDomainError(error)) return false;

  const status = (error as { status?: unknown } | null)?.status;

  return !(typeof status === 'number' && status < 500);
};

const begin = (
  trace: Trace,
  parentSpanId: string | undefined,
  name: string,
  kind: SpanRecord['kind'],
  attributes: SpanAttributes,
): SpanRecord => {
  const span: SpanRecord = {
    spanId: randomBytes(8).toString('hex'),
    parentSpanId,
    name,
    kind,
    startMs: trace.owner.now(),
    endMs: undefined,
    attributes: safeAttributes(attributes),
    error: false,
  };

  trace.spans.push(span);
  trace.open += 1;

  return span;
};

const finish = (trace: Trace, span: SpanRecord, error?: unknown): void => {
  if (span.endMs !== undefined) return;

  span.endMs = trace.owner.now();

  if (error !== undefined) {
    span.error = true;
    span.attributes = {
      ...span.attributes,
      ...safeAttributes({ 'error.type': error instanceof Error ? error.name : typeof error }),
    };

    if (unexpected(error)) trace.error = true;
  }

  trace.open -= 1;

  if (trace.open === 0) trace.owner.settle(trace);
};

/**
 * Runs `run` inside a span, a child of whichever span is current.
 *
 * Outside a trace this is `run()` and nothing else — which is every test that
 * is not about tracing, and every deployment with nowhere to send one.
 */
export const withSpan = async <T>(
  name: string,
  run: (span: Pick<OpenSpan, 'set'>) => Promise<T> | T,
  attributes: SpanAttributes = {},
): Promise<T> => {
  const current = storage.getStore();

  if (current === undefined) return await run(NOT_TRACING);

  const { trace } = current;
  const span = begin(trace, current.spanId, name, 'internal', attributes);
  const set = (more: SpanAttributes): void => {
    span.attributes = { ...span.attributes, ...safeAttributes(more) };
  };

  try {
    const result = await storage.run({ trace, spanId: span.spanId }, () => run({ set }));

    finish(trace, span);

    return result;
  } catch (error) {
    finish(trace, span, error);

    throw error;
  }
};

/** Begins a span that the caller ends: for the body of a generator, whose `yield` no callback can hold. */
export const openSpan = (name: string, attributes: SpanAttributes = {}): OpenSpan => {
  const current = storage.getStore();

  if (current === undefined) return NOT_TRACING;

  const { trace } = current;
  const span = begin(trace, current.spanId, name, 'internal', attributes);

  return {
    set: (more) => {
      span.attributes = { ...span.attributes, ...safeAttributes(more) };
    },
    end: (error) => {
      finish(trace, span, error);
    },
  };
};

/** Waits for whatever this request's trace has to send. Never throws, never waits long. */
export const flushTraces = async (): Promise<void> => {
  await storage.getStore()?.trace.owner.flush();
};

/* ------------------------------------------------------------ what leaves */

type OtlpValue =
  | { readonly stringValue: string }
  | { readonly intValue: string }
  | { readonly doubleValue: number }
  | { readonly boolValue: boolean };

interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpValue;
}

/** One export: the OTLP/HTTP JSON body for `POST /v1/traces`. */
export interface OtlpTraces {
  readonly resourceSpans: readonly {
    readonly resource: { readonly attributes: readonly OtlpAttribute[] };
    readonly scopeSpans: readonly {
      readonly scope: { readonly name: string };
      readonly spans: readonly {
        readonly traceId: string;
        readonly spanId: string;
        readonly parentSpanId?: string;
        readonly name: string;
        /** `SPAN_KIND_INTERNAL` is 1, `SPAN_KIND_SERVER` is 2. */
        readonly kind: 1 | 2;
        readonly startTimeUnixNano: string;
        readonly endTimeUnixNano: string;
        readonly attributes: readonly OtlpAttribute[];
        /** `STATUS_CODE_ERROR` is 2; absent is unset. */
        readonly status?: { readonly code: 2 };
      }[];
    }[];
  }[];
}

export type TraceExporter = (traces: OtlpTraces) => Promise<void>;

const otlpValue = (value: SpanValue): OtlpValue => {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };

  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
};

const otlpAttributes = (attributes: Record<string, SpanValue>): OtlpAttribute[] =>
  Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));

const nanos = (ms: number): string => `${String(Math.round(ms))}000000`;

/** How long an export may take before it is abandoned: a trace is never worth a visitor's wait. */
export const EXPORT_TIMEOUT_MS = 1_000;

/**
 * Sends traces to an OTLP/HTTP endpoint — the collector beside the function,
 * or a vendor's.
 *
 * `endpoint` is the base, as `OTEL_EXPORTER_OTLP_ENDPOINT` gives it; the
 * signal's path is added here. It is the operator's configuration, never a
 * value a request supplied, which is why this is a plain `fetch`.
 */
export const otlpHttpExporter =
  ({
    endpoint,
    headers = {},
    fetch: send = globalThis.fetch,
  }: {
    readonly endpoint: string;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly fetch?: typeof globalThis.fetch | undefined;
  }): TraceExporter =>
  async (traces) => {
    const response = await send(`${endpoint.replace(/\/+$/u, '')}/v1/traces`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(traces),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });

    if (!response.ok) throw new Error(`OTLP export answered ${String(response.status)}`);
  };

/**
 * `OTEL_EXPORTER_OTLP_HEADERS` as OpenTelemetry writes it: `name=value` pairs
 * separated by commas, a value percent-encoded where it needs to be. This is
 * where a vendor's API key arrives, so a pair that cannot be read is left out
 * rather than guessed at.
 */
export const otlpHeaders = (value: string | undefined): Record<string, string> => {
  const headers: Record<string, string> = {};

  for (const pair of (value ?? '').split(',')) {
    const at = pair.indexOf('=');
    const name = pair.slice(0, Math.max(at, 0)).trim();

    if (name === '') continue;

    try {
      headers[name] = decodeURIComponent(pair.slice(at + 1).trim());
    } catch {
      /* Not percent-encoding after all: a header that is wrong is worse than one that is absent. */
    }
  }

  return headers;
};

/* ------------------------------------------------------------ the recorder */

export interface TelemetryOptions {
  /** Where traces go. Absent, nothing is traced at all. */
  readonly exporter?: TraceExporter | undefined;
  /** `service.name`, `deployment.environment` and the build, on every export. */
  readonly resource?: Readonly<Record<string, string>> | undefined;
  /** The share of unremarkable traces kept. A tenth, as the row says. */
  readonly sampleRate?: number | undefined;
  /** A trace at least this long is kept whatever the dice say. */
  readonly slowMs?: number | undefined;
  readonly random?: (() => number) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface Telemetry {
  /** One trace per request. Register it directly after the request context. */
  readonly middleware: () => MiddlewareHandler<AppEnv>;
  /** Waits for every export begun so far. */
  readonly flush: () => Promise<void>;
}

export const DEFAULT_SAMPLE_RATE = 0.1;

/**
 * Slow, for the purpose of always keeping the trace. A chat turn is a model
 * writing a paragraph and is seconds long when nothing is wrong; this is past
 * where one is, and far past where any other route should be.
 */
export const DEFAULT_SLOW_MS = 8_000;

const passThrough: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};

export const createTelemetry = ({
  exporter,
  resource = {},
  sampleRate = DEFAULT_SAMPLE_RATE,
  slowMs = DEFAULT_SLOW_MS,
  random = Math.random,
  now = Date.now,
}: TelemetryOptions = {}): Telemetry => {
  if (exporter === undefined) {
    return { middleware: () => passThrough, flush: () => Promise.resolve() };
  }

  const pending = new Set<Promise<void>>();

  const flush = async (): Promise<void> => {
    await Promise.all(pending);
  };

  const send = (trace: Trace, spans: readonly SpanRecord[]): void => {
    const body: OtlpTraces = {
      resourceSpans: [
        {
          resource: { attributes: otlpAttributes(resource) },
          scopeSpans: [
            {
              scope: { name: 'catalogorosso' },
              spans: spans.map((span) => ({
                traceId: trace.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
                name: span.name,
                kind: span.kind === 'server' ? 2 : 1,
                startTimeUnixNano: nanos(span.startMs),
                endTimeUnixNano: nanos(span.endMs ?? span.startMs),
                /* The ids last, so nothing a span said of itself can stand in for them. */
                attributes: otlpAttributes({ ...span.attributes, ...trace.ids }),
                ...(span.error ? { status: { code: 2 as const } } : {}),
              })),
            },
          ],
        },
      ],
    };

    /*
     * **A failed export is logged and is nobody's failure.** Awaited by `flush`
     * so the function is not frozen with it in flight, and bounded by the
     * exporter's own timeout so that wait is short.
     */
    const exporting = exporter(body)
      .catch((error: unknown) => {
        logger.warn({ kind: 'trace_export_failed', err: error }, 'a trace could not be exported');
      })
      .finally(() => {
        pending.delete(exporting);
      });

    pending.add(exporting);
  };

  const settle = (trace: Trace): void => {
    const spans = trace.spans.slice(trace.settled);

    trace.settled = trace.spans.length;

    if (trace.sampled === undefined) {
      const started = Math.min(...trace.spans.map((span) => span.startMs));
      const ended = Math.max(...trace.spans.map((span) => span.endMs ?? span.startMs));

      trace.sampled = trace.error || ended - started >= slowMs || random() < sampleRate;
    }

    if (trace.sampled && spans.length > 0) send(trace, spans);
  };

  const recorder: Recorder = { settle, now, flush };

  return {
    flush,
    middleware: () => async (c, next) => {
      const trace: Trace = {
        traceId: randomBytes(16).toString('hex'),
        spans: [],
        open: 0,
        error: false,
        ids: {},
        sampled: undefined,
        settled: 0,
        owner: recorder,
      };
      const root = begin(trace, undefined, 'http.request', 'server', {
        'http.method': c.req.method,
      });

      try {
        await storage.run({ trace, spanId: root.spanId }, next);
      } finally {
        /*
         * Read now, because none of it was known when the request began: the
         * winery is resolved from a membership or a key, the session from a
         * token. Hono has already turned a thrown error into its response, so
         * the status is the one the caller gets.
         */
        const { status } = c.res;

        const widgetTenant = c.get('widgetTenant') as { tenantId: string } | undefined;

        trace.ids = safeAttributes({
          request_id: getRequestContext()?.requestId,
          /* A member's winery is in the request context (P0-47); a visitor's is the widget's own. */
          tenant_id: getRequestContext()?.tenantId ?? widgetTenant?.tenantId,
          session_id: c.get('widgetSessionId'),
        });
        root.attributes = {
          ...root.attributes,
          ...safeAttributes({ 'http.route': routePath(c), 'http.status_code': status }),
        };

        if (status >= 500) {
          root.error = true;
          trace.error = true;
        }

        finish(trace, root);

        /*
         * A buffered response is held until this resolves, so it waits only for
         * a trace that was kept. A stream is still open here with its spans
         * unfinished; the route that streams waits for its own (`flushTraces`).
         */
        await flush();
      }
    },
  };
};
