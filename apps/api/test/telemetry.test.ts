import { NotFoundError, setRequestTenant } from '@catalogorosso/core';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../src/env.js';
import { errorHandler, normaliseThrown } from '../src/middleware/error.js';
import { logger, requestContext } from '../src/middleware/logger.js';
import {
  createTelemetry,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_SLOW_MS,
  EXPORT_TIMEOUT_MS,
  flushTraces,
  openSpan,
  otlpHeaders,
  otlpHttpExporter,
  safeAttributes,
  SPAN_ATTRIBUTES,
  withSpan,
  type OtlpTraces,
  type TelemetryOptions,
} from '../src/telemetry.js';

/**
 * Tracing (P7-01): what a trace is made of, which ones are kept, and what a
 * span is allowed to say.
 *
 * The span tree of a real chat turn is asserted in `telemetry-chat.test.ts`,
 * through the app and the chat port. What is here needs neither: the recorder,
 * the sampling, the list of attributes, and the two ways a response leaves.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const TENANT = '11111111-1111-4111-8111-111111111111';

type ExportedSpan = OtlpTraces['resourceSpans'][number]['scopeSpans'][number]['spans'][number];

/** An exporter that keeps what it is given. */
const collecting = () => {
  const exports: OtlpTraces[] = [];
  const spans = (): ExportedSpan[] =>
    exports.flatMap((sent) =>
      sent.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
    );

  return {
    exports,
    spans,
    named: (name: string): ExportedSpan | undefined => spans().find((span) => span.name === name),
    exporter: (traces: OtlpTraces) => {
      exports.push(traces);

      return Promise.resolve();
    },
  };
};

const attributesOf = (span: ExportedSpan | undefined): Record<string, unknown> =>
  Object.fromEntries(
    (span?.attributes ?? []).map(({ key, value }) => [key, Object.values(value)[0]]),
  );

/** Always kept, unless a test says otherwise: the dice come up nought. */
const KEPT = { random: () => 0 } satisfies TelemetryOptions;
/** Never kept by the dice: only an error or a slow trace gets through. */
const UNLUCKY = { random: () => 0.999 } satisfies TelemetryOptions;

const appWith = (options: TelemetryOptions, routes: (app: Hono<AppEnv>) => void) => {
  const telemetry = createTelemetry(options);
  const app = new Hono<AppEnv>();

  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);

  app.use('*', requestContext());
  app.use('*', telemetry.middleware());
  app.use('*', normaliseThrown());
  app.onError(errorHandler);
  routes(app);

  return { app, telemetry };
};

describe('what a span may say', () => {
  it('keeps an identifier, a number and a flag under a name on the list', () => {
    expect(
      safeAttributes({
        tenant_id: TENANT,
        'llm.model': 'amazon.nova-lite-v1:0',
        'http.route': '/v1/widget/chat',
        'llm.input_tokens': 900,
        'chat.sandbox': true,
        'rag.fused': 0,
      }),
    ).toEqual({
      tenant_id: TENANT,
      'llm.model': 'amazon.nova-lite-v1:0',
      'http.route': '/v1/widget/chat',
      'llm.input_tokens': 900,
      'chat.sandbox': true,
      'rag.fused': 0,
    });
  });

  it.each([
    ['a sentence', 'qualcosa per una bistecca'],
    ['an email address', 'giulia@example.com'],
    ['a sentence with no spaces but a tab', 'un\tbarolo'],
    ['something too long to be an id', 'x'.repeat(97)],
    ['nothing', ''],
    ['not a number', Number.NaN],
    ['an infinity', Number.POSITIVE_INFINITY],
    ['an object', { question: 'un rosso' }],
    ['a list', ['a']],
  ])('drops %s, whatever name it came under', (_what, value) => {
    expect(safeAttributes({ 'llm.outcome': value as never, session_id: 's1' })).toEqual({
      session_id: 's1',
    });
  });

  it('keeps a value exactly as long as an id may be', () => {
    expect(safeAttributes({ session_id: 'x'.repeat(96) })).toEqual({ session_id: 'x'.repeat(96) });
  });

  it('drops a name that is not on the list, however harmless its value', () => {
    expect(
      safeAttributes({ tenant_id: TENANT, question: 'barolo', 'user.email': 'a' } as never),
    ).toEqual({ tenant_id: TENANT });
  });

  it('has no name on the list that could hold what somebody typed', () => {
    /* The list is the decision. This is here so that changing it is a decision too. */
    expect([...SPAN_ATTRIBUTES].sort()).toEqual(
      [
        'chat.sandbox',
        'error.type',
        'http.method',
        'http.route',
        'http.status_code',
        'llm.input_tokens',
        'llm.model',
        'llm.outcome',
        'llm.output_tokens',
        'llm.tier',
        'rag.candidates',
        'rag.fused',
        'rag.lexical_hits',
        'rag.model',
        'rag.vector_hits',
        'request_id',
        'session_id',
        'tenant_id',
      ].sort(),
    );
  });
});

describe('with nowhere to send a trace', () => {
  it('traces nothing, and every helper is the function it wraps', async () => {
    /*
     * Dice that would keep every trace and a clock that would time every span,
     * and neither is so much as consulted: nothing was begun. Left to the real
     * dice, a recorder that was wrongly on would be caught one run in ten.
     */
    const now = vi.fn(() => 0);
    const random = vi.fn(() => 0);
    const { app } = appWith({ now, random }, (hono) => {
      hono.get('/x', async (c) => {
        const manual = openSpan('by.hand');

        manual.set({ tenant_id: TENANT });
        manual.end();
        await flushTraces();

        return c.text(await withSpan('work', (span) => (span.set({ 'rag.fused': 1 }), 'done')));
      });
    });

    const response = await app.request('/x');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('done');
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it('runs a span’s work outside any request, where there is no trace to belong to', async () => {
    await expect(withSpan('orphan', () => Promise.resolve(42))).resolves.toBe(42);
    await expect(
      withSpan('orphan', () => Promise.reject(new Error('still raised'))),
    ).rejects.toThrow('still raised');
  });
});

describe('a trace', () => {
  it('is one request: a server span at the root, with the route’s template and how it ended', async () => {
    const sink = collecting();
    const { app } = appWith({ ...KEPT, exporter: sink.exporter }, (hono) => {
      hono.get('/wines/:id', (c) => c.json({ ok: true }));
    });

    await app.request('/wines/3f1c0b7e');

    const [root] = sink.spans();

    expect(sink.exports).toHaveLength(1);
    expect(sink.spans()).toHaveLength(1);
    expect(root).toMatchObject({ name: 'http.request', kind: 2 });
    expect(root?.parentSpanId).toBeUndefined();
    expect(root?.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(root?.spanId).toMatch(/^[0-9a-f]{16}$/u);
    /* The template, not the address: an id in a path is still an id somebody's request named. */
    expect(attributesOf(root)).toMatchObject({
      'http.method': 'GET',
      'http.route': '/wines/:id',
      'http.status_code': '200',
    });
    expect(root?.status).toBeUndefined();
  });

  it('nests what happens inside it, each span under the one it ran in', async () => {
    const sink = collecting();
    const { app } = appWith({ ...KEPT, exporter: sink.exporter }, (hono) => {
      hono.get('/x', async (c) => {
        await withSpan('outer', async () => {
          await withSpan('inner', () => Promise.resolve());

          const manual = openSpan('by.hand', { 'llm.model': 'm1' });

          manual.set({ 'llm.output_tokens': 60 });
          manual.end();
        });
        await withSpan('sibling', () => Promise.resolve(), { 'rag.fused': 3 });

        return c.text('ok');
      });
    });

    await app.request('/x');

    const id = (name: string) => sink.named(name)?.spanId;
    const parent = (name: string) => sink.named(name)?.parentSpanId;

    expect(sink.spans().map((span) => span.name)).toEqual([
      'http.request',
      'outer',
      'inner',
      'by.hand',
      'sibling',
    ]);
    expect(parent('outer')).toBe(id('http.request'));
    expect(parent('inner')).toBe(id('outer'));
    expect(parent('by.hand')).toBe(id('outer'));
    expect(parent('sibling')).toBe(id('http.request'));
    expect(new Set(sink.spans().map((span) => span.traceId)).size).toBe(1);
    expect(sink.named('inner')?.kind).toBe(1);
    expect(attributesOf(sink.named('by.hand'))).toMatchObject({
      'llm.model': 'm1',
      'llm.output_tokens': '60',
    });
    expect(attributesOf(sink.named('sibling'))).toMatchObject({ 'rag.fused': '3' });
  });

  it('puts the request, the winery and the session on every span, whenever each became known', async () => {
    const sink = collecting();
    const { app } = appWith({ ...KEPT, exporter: sink.exporter }, (hono) => {
      hono.get('/x', async (c) => {
        /* Begun before anybody knew whose request this was. */
        await withSpan('early', () => Promise.resolve());

        setRequestTenant(TENANT);
        c.set('widgetSessionId', 'sess-1');

        await withSpan('late', () => Promise.resolve());

        return c.text('ok');
      });
    });

    const response = await app.request('/x');
    const requestId = response.headers.get('x-request-id');

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(sink.spans()).toHaveLength(3);

    for (const span of sink.spans()) {
      expect(attributesOf(span), span.name).toMatchObject({
        request_id: requestId,
        tenant_id: TENANT,
        session_id: 'sess-1',
      });
    }
  });

  it('reads a visitor’s winery from the widget’s own resolution, where no membership names one', async () => {
    const sink = collecting();
    const { app } = appWith({ ...KEPT, exporter: sink.exporter }, (hono) => {
      hono.get('/x', (c) => {
        c.set('widgetTenant', { tenantId: TENANT } as never);

        return c.text('ok');
      });
    });

    await app.request('/x');

    expect(attributesOf(sink.named('http.request'))).toMatchObject({ tenant_id: TENANT });
  });

  it('carries the service it came from, once, on the export', async () => {
    const sink = collecting();
    const { app } = appWith(
      { ...KEPT, exporter: sink.exporter, resource: { 'service.name': 'catalogorosso-api' } },
      (hono) => {
        hono.get('/x', (c) => c.text('ok'));
      },
    );

    await app.request('/x');

    expect(sink.exports[0]?.resourceSpans[0]?.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'catalogorosso-api' } },
    ]);
    expect(sink.exports[0]?.resourceSpans[0]?.scopeSpans[0]?.scope).toEqual({
      name: 'catalogorosso',
    });
  });

  it('times a span from when it began to when it ended, in nanoseconds', async () => {
    const sink = collecting();
    let at = 1_760_263_200_000;
    const { app } = appWith({ ...KEPT, exporter: sink.exporter, now: () => at }, (hono) => {
      hono.get('/x', async (c) => {
        at += 5;
        await withSpan('work', () => {
          at += 40;
        });

        return c.text('ok');
      });
    });

    await app.request('/x');

    expect(sink.named('http.request')).toMatchObject({
      startTimeUnixNano: '1760263200000000000',
      endTimeUnixNano: '1760263200045000000',
    });
    expect(sink.named('work')).toMatchObject({
      startTimeUnixNano: '1760263200005000000',
      endTimeUnixNano: '1760263200045000000',
    });
  });
});

describe('a span that misbehaves', () => {
  it('is ended once, however many times it is told to end', async () => {
    /* A second `end` must not count as another span finishing: the trace would be sent before its root had. */
    const sink = collecting();
    const { app } = appWith({ ...KEPT, exporter: sink.exporter }, (hono) => {
      hono.get('/x', async (c) => {
        const manual = openSpan('by.hand');

        manual.end();
        manual.end();
        manual.end(new Error('too late to matter'));

        await withSpan('after', () => Promise.resolve());

        return c.text('ok');
      });
    });

    await app.request('/x');

    expect(sink.exports).toHaveLength(1);
    expect(sink.spans().map((span) => span.name)).toEqual(['http.request', 'by.hand', 'after']);
    expect(attributesOf(sink.named('http.request'))).toMatchObject({ 'http.status_code': '200' });
    expect(sink.named('by.hand')?.status).toBeUndefined();
  });

  it('cannot say it belongs to another winery, session or request', async () => {
    const sink = collecting();
    const { app } = appWith({ ...KEPT, exporter: sink.exporter }, (hono) => {
      hono.get('/x', async (c) => {
        setRequestTenant(TENANT);
        c.set('widgetSessionId', 'sess-1');

        await withSpan('lying', () => Promise.resolve(), {
          tenant_id: '99999999-9999-4999-8999-999999999999',
          session_id: 'somebody-else',
          request_id: 'made-up',
        });

        return c.text('ok');
      });
    });

    const response = await app.request('/x');

    expect(attributesOf(sink.named('lying'))).toMatchObject({
      tenant_id: TENANT,
      session_id: 'sess-1',
      request_id: response.headers.get('x-request-id'),
    });
  });
});

describe('which traces are kept', () => {
  const plain = (options: TelemetryOptions) =>
    appWith(options, (hono) => {
      hono.get('/x', (c) => c.text('ok'));
    });

  it('keeps a tenth of the unremarkable ones, by default', async () => {
    expect(DEFAULT_SAMPLE_RATE).toBe(0.1);

    for (const [dice, kept] of [
      [0, 1],
      [0.0999, 1],
      [0.1, 0],
      [0.999, 0],
    ] as const) {
      const sink = collecting();

      await plain({ exporter: sink.exporter, random: () => dice }).app.request('/x');

      expect(sink.exports, `dice ${String(dice)}`).toHaveLength(kept);
    }
  });

  it('keeps the share it is told to', async () => {
    const sink = collecting();

    await plain({ exporter: sink.exporter, random: () => 0.5, sampleRate: 0.6 }).app.request('/x');
    await plain({ exporter: sink.exporter, random: () => 0.7, sampleRate: 0.6 }).app.request('/x');

    expect(sink.exports).toHaveLength(1);
  });

  it('keeps every one that failed, and marks where', async () => {
    const sink = collecting();
    const { app } = appWith({ ...UNLUCKY, exporter: sink.exporter }, (hono) => {
      hono.get('/x', async () => {
        await withSpan('work', () => {
          throw new TypeError('postgres://app_rw:hunter2@db.internal/x');
        });

        return new Response('unreachable');
      });
    });

    const response = await app.request('/x');

    expect(response.status).toBe(500);
    expect(sink.exports).toHaveLength(1);
    expect(sink.named('work')?.status).toEqual({ code: 2 });
    expect(sink.named('http.request')?.status).toEqual({ code: 2 });
    /* The kind of error, never its words: a driver's message holds a connection string. */
    expect(attributesOf(sink.named('work'))).toMatchObject({ 'error.type': 'TypeError' });
    expect(JSON.stringify(sink.exports)).not.toContain('hunter2');
  });

  it('keeps a 5xx that nothing inside a span raised', async () => {
    const sink = collecting();
    const { app } = appWith({ ...UNLUCKY, exporter: sink.exporter }, (hono) => {
      hono.get('/x', (c) => c.text('down', 503));
    });

    await app.request('/x');

    expect(sink.exports).toHaveLength(1);
    expect(attributesOf(sink.named('http.request'))).toMatchObject({ 'http.status_code': '503' });
  });

  it.each([
    ['a refusal the API wrote', () => new NotFoundError()],
    ['a spent month', () => Object.assign(new Error('quota'), { status: 429 })],
  ])('does not keep %s for its own sake: it is the system working', async (_what, refusal) => {
    const sink = collecting();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { app } = appWith({ ...UNLUCKY, exporter: sink.exporter }, (hono) => {
      hono.get('/x', async (c) => {
        await withSpan('work', () => {
          throw refusal();
        }).catch(() => undefined);

        return c.text('refused', 404);
      });
    });

    await app.request('/x');

    expect(sink.exports).toEqual([]);
  });

  it('still marks a refusal on its span when the trace is kept anyway', async () => {
    const sink = collecting();
    const { app } = appWith({ ...KEPT, exporter: sink.exporter }, (hono) => {
      hono.get('/x', async (c) => {
        await withSpan('work', () => {
          throw new NotFoundError();
        }).catch(() => undefined);

        return c.text('refused', 404);
      });
    });

    await app.request('/x');

    expect(sink.named('work')?.status).toEqual({ code: 2 });
    expect(sink.named('http.request')?.status).toBeUndefined();
  });

  it('keeps every one that was slow, from its first span’s start to its last one’s end', async () => {
    expect(DEFAULT_SLOW_MS).toBe(8_000);

    for (const [took, kept] of [
      [7_999, 0],
      [8_000, 1],
    ] as const) {
      const sink = collecting();
      let at = 1_000;
      const { app } = appWith({ ...UNLUCKY, exporter: sink.exporter, now: () => at }, (hono) => {
        hono.get('/x', (c) => {
          at += took;

          return c.text('ok');
        });
      });

      await app.request('/x');

      expect(sink.exports, `${String(took)} ms`).toHaveLength(kept);
    }
  });

  it('is slow at the threshold it is given', async () => {
    const sink = collecting();
    let at = 0;
    const { app } = appWith(
      { ...UNLUCKY, exporter: sink.exporter, now: () => at, slowMs: 50 },
      (hono) => {
        hono.get('/x', (c) => {
          at += 50;

          return c.text('ok');
        });
      },
    );

    await app.request('/x');

    expect(sink.exports).toHaveLength(1);
  });
});

describe('getting a trace out before the function is frozen', () => {
  it('holds a buffered response until its trace has been sent', async () => {
    let sent = false;
    const { app } = appWith(
      {
        ...KEPT,
        exporter: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          sent = true;
        },
      },
      (hono) => {
        hono.get('/x', (c) => c.text('ok'));
      },
    );

    await app.request('/x');

    expect(sent).toBe(true);
  });

  it('never fails a request because a trace could not be sent', async () => {
    const warned = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { app } = appWith(
      { ...KEPT, exporter: () => Promise.reject(new Error('collector down')) },
      (hono) => {
        hono.get('/x', (c) => c.text('ok'));
      },
    );

    const response = await app.request('/x');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(warned).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'trace_export_failed' }),
      expect.any(String),
    );
  });

  it('keeps a stream’s trace open until the stream is over, and sends it whole', async () => {
    /*
     * The handler returns as soon as the stream begins, so the root span ends
     * first. The trace is not over until the turn inside the stream is — and
     * the route waits for the export itself, since nothing else will.
     */
    const sink = collecting();
    const order: string[] = [];
    /* The model, taking its time: the answer is still being written when the handler has returned. */
    let finishWriting: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => {
      finishWriting = resolve;
    });
    const { app } = appWith(
      {
        ...KEPT,
        exporter: async (traces) => {
          await sink.exporter(traces);
          order.push('exported');
        },
      },
      (hono) => {
        hono.get('/stream', (c) =>
          streamSSE(c, async (stream) => {
            await withSpan('chat.turn', async () => {
              await stream.writeSSE({ event: 'text', data: 'a' });
              await writing;
              await withSpan('llm.generate', () => Promise.resolve());
            });
            await stream.writeSSE({ event: 'done', data: '{}' });
            await flushTraces();
            order.push('stream closed');
          }),
        );
      },
    );

    const response = await app.request('/stream');

    order.push('response returned');

    expect(sink.exports).toEqual([]);

    finishWriting();
    await response.text();

    expect(sink.exports).toHaveLength(1);
    expect(sink.spans().map((span) => span.name)).toEqual([
      'http.request',
      'chat.turn',
      'llm.generate',
    ]);
    expect(sink.named('chat.turn')?.parentSpanId).toBe(sink.named('http.request')?.spanId);
    expect(order).toEqual(['response returned', 'exported', 'stream closed']);
  });

  it('decides once: a span that arrives after the trace was kept is sent after it', async () => {
    const sink = collecting();
    let straggler: Promise<void> = Promise.resolve();
    const { app, telemetry } = appWith({ ...KEPT, exporter: sink.exporter }, (hono) => {
      hono.get('/x', (c) => {
        straggler = new Promise((resolve) => {
          setTimeout(() => {
            void withSpan('afterwards', () => Promise.resolve()).then(resolve);
          }, 5);
        });

        return c.text('ok');
      });
    });

    await app.request('/x');
    expect(sink.spans().map((span) => span.name)).toEqual(['http.request']);

    await straggler;
    await telemetry.flush();

    /* Its own export, carrying only itself: the root is not sent twice. */
    expect(sink.exports).toHaveLength(2);
    expect(
      sink.exports[1]?.resourceSpans[0]?.scopeSpans[0]?.spans.map((span) => span.name),
    ).toEqual(['afterwards']);
    expect(sink.named('afterwards')?.traceId).toBe(sink.named('http.request')?.traceId);
  });

  it('decides once: a span that arrives after the trace was dropped is dropped too', async () => {
    const sink = collecting();
    let straggler: Promise<void> = Promise.resolve();
    let dice = 0.999;
    const { app, telemetry } = appWith({ exporter: sink.exporter, random: () => dice }, (hono) => {
      hono.get('/x', (c) => {
        straggler = new Promise((resolve) => {
          setTimeout(() => {
            void withSpan('afterwards', () => Promise.resolve()).then(resolve);
          }, 5);
        });

        return c.text('ok');
      });
    });

    await app.request('/x');

    /* Were the dice thrown again, this one would be kept. */
    dice = 0;

    await straggler;
    await telemetry.flush();

    expect(sink.exports).toEqual([]);
  });
});

describe('sending to an OTLP endpoint', () => {
  const TRACES: OtlpTraces = { resourceSpans: [] };

  it('posts the traces as JSON to the endpoint’s own path, with the headers it was given', async () => {
    const send = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 })));

    await otlpHttpExporter({
      endpoint: 'http://localhost:4318/',
      headers: { authorization: 'Bearer abc' },
      fetch: send,
    })(TRACES);

    const [url, init] = send.mock.calls[0] ?? [];

    expect(url).toBe('http://localhost:4318/v1/traces');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer abc', 'content-type': 'application/json' },
      body: JSON.stringify(TRACES),
    });
    /* Bounded: an export is never worth more than this of anybody's wait. */
    expect(EXPORT_TIMEOUT_MS).toBe(1_000);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('says so when the endpoint refuses, so the failure is logged and not assumed sent', async () => {
    const exporter = otlpHttpExporter({
      endpoint: 'https://otlp.example',
      fetch: () => Promise.resolve(new Response('no', { status: 401 })),
    });

    await expect(exporter(TRACES)).rejects.toThrow('OTLP export answered 401');
  });

  it.each([
    [undefined, {}],
    ['', {}],
    ['authorization=Bearer%20abc', { authorization: 'Bearer abc' }],
    [' x-team = wine , x-key=a=b ', { 'x-team': 'wine', 'x-key': 'a=b' }],
    /* A pair that cannot be read is left out, and the ones beside it are kept. */
    ['broken,=nameless,x-ok=1,x-bad=%E0%A4%A', { 'x-ok': '1' }],
  ])('reads the headers OpenTelemetry’s variable holds: %s', (value, headers) => {
    expect(otlpHeaders(value)).toEqual(headers);
  });
});
