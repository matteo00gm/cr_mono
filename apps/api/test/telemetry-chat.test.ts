import { randomUUID } from 'node:crypto';

import type { EmbeddingProvider, LlmProvider, PairingChunk } from '@catalogorosso/core';
import { memoryRateLimiter } from '@catalogorosso/security';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv, WidgetTenant } from '../src/env.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * The span tree of a chat turn (P7-01) — the row's own test: one request, a
 * stubbed exporter, the tree it produced, and nothing a person typed in it.
 *
 * **Through the app and the real chat port.** The spans are placed by the code
 * that does the work, so a test that built them by hand would assert only that
 * the test can build a tree. The driver is mocked, as in `chat-port.test.ts`;
 * every function between the route and the model is the real one.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

const stored = {
  rows: [] as Record<string, unknown>[],
  fused: [] as Record<string, unknown>[],
};

vi.mock('@catalogorosso/db', async (original) => ({
  ...(await original<typeof import('@catalogorosso/db')>()),
  withTenant: (_tenantId: string, run: (tx: unknown) => unknown) => run({}),
  fusedSearch: () => Promise.resolve(stored.fused),
  productsByIds: () => Promise.resolve(stored.rows),
  readConversation: () => Promise.resolve([]),
  recordTurn: () => Promise.resolve({ conversationId: 'c1', started: true }),
  recordUsage: () => Promise.resolve(),
}));

const { createApp } = await import('../src/app.js');
const { createChatPort } = await import('../src/chat.js');
const { logger, requestContext } = await import('../src/middleware/logger.js');
const { createRagPort } = await import('../src/rag.js');
const { createTelemetry, SPAN_ATTRIBUTES } = await import('../src/telemetry.js');

type OtlpTraces = import('../src/telemetry.js').OtlpTraces;
type ProviderFor = import('../src/chat.js').ProviderFor;
type ExportedSpan = OtlpTraces['resourceSpans'][number]['scopeSpans'][number]['spans'][number];

/** Everything a person could have typed, or a model written, in this turn. */
const QUESTION =
  'Sono Giulia Rossi, giulia.rossi@example.com, +39 333 1234567: qualcosa per una bistecca?';
const REPLY = 'Con la bistecca le consiglio il Barolo.';
const REASON = 'Regge la carne alla griglia.';
const WINE = 'Barolo Monfortino';

const embeddings: EmbeddingProvider = {
  model: 'amazon.titan-embed-text-v2:0',
  dim: 4,
  embed: (texts) => Promise.resolve(texts.map(() => [0.1, 0.2, 0.3, 0.4])),
};

const collecting = () => {
  const exports: OtlpTraces[] = [];

  return {
    exports,
    spans: (): ExportedSpan[] =>
      exports.flatMap((sent) =>
        sent.resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) => scope.spans),
        ),
      ),
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

/** `parent > child` for every span, in the order they began. */
const treeOf = (spans: readonly ExportedSpan[]): string[] => {
  const names = new Map(spans.map((span) => [span.spanId, span.name]));

  return spans.map((span) =>
    span.parentSpanId === undefined
      ? span.name
      : `${names.get(span.parentSpanId) ?? '?'} > ${span.name}`,
  );
};

const chatWith = (productId: string) => {
  const chunks: PairingChunk[] = [
    { type: 'text', delta: REPLY },
    { type: 'recommendations', items: [{ productId, reason: REASON, confidence: 0.9 }] },
  ];

  const speaking: ProviderFor = (onUsage) =>
    ({
      id: 'spoken',
      streamPairing: () =>
        (async function* () {
          for (const chunk of chunks) yield await Promise.resolve(chunk);

          onUsage({
            inputTokens: 900,
            outputTokens: 60,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
          });
        })(),
    }) satisfies LlmProvider;

  return createChatPort({
    embeddings,
    /* Either tier answers: a question this long is one P2-28 sends to the stronger model. */
    providers: { base: speaking, strong: speaking },
    models: { base: 'amazon.nova-lite-v1:0', strong: 'amazon.nova-2-lite-v1:0' },
    quota: {
      readUsage: () => Promise.resolve(0),
      readPurchased: () => Promise.resolve(0),
      check: () =>
        Promise.resolve({ allowed: true, state: 'ok', inOverage: false, used: 0, limit: 1_500 }),
    },
  });
};

let productId = '';

beforeEach(() => {
  productId = randomUUID();
  stored.rows = [
    {
      id: productId,
      name: WINE,
      producer: 'Giacomo Conterno',
      vintage: 2019,
      wineType: 'red',
      grapeVarieties: ['Nebbiolo'],
      region: 'Piemonte',
      denomination: 'Barolo DOCG',
      styleTags: ['strutturato'],
      tastingNotes: 'Tannino deciso.',
      foodPairings: ['brasato'],
      alcoholPct: '14.50',
      priceCents: 2_000,
      currency: 'EUR',
      imageUrl: null,
      productUrl: null,
      stockStatus: 'IN_STOCK',
      externalVariantId: null,
    },
  ];
  /*
   * One wine the vector branch found, and two only the words did — which have
   * no row behind them here and are left out of the prompt. Three different
   * numbers, so no count can stand in for another.
   */
  stored.fused = [
    {
      productId,
      score: 1,
      vectorRank: 1,
      lexicalRank: null,
      vectorDistance: 0,
      stockStatus: 'IN_STOCK',
      priceCents: 2_000,
    },
    ...[1, 2].map((lexicalRank) => ({
      productId: randomUUID(),
      score: 0.5,
      vectorRank: null,
      lexicalRank,
      vectorDistance: null,
      stockStatus: 'IN_STOCK',
      priceCents: 2_000,
    })),
  ];
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});

describe('one answer asked in the sandbox, through the app', () => {
  const answered = async (query = QUESTION) => {
    const sink = collecting();
    const app = createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT),
      telemetry: createTelemetry({ exporter: sink.exporter, random: () => 0 }),
      rag: createRagPort({
        provider: embeddings,
        answering: {
          chat: chatWith(productId),
          limiter: memoryRateLimiter(),
          readService: () =>
            Promise.resolve({ status: 'ACTIVE', trialEndsAt: null, plan: 'CANTINA', locale: 'it' }),
        },
      }),
    });

    const response = await app.request('/v1/dashboard/rag/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    return { response, sink };
  };

  it('is one trace: the request, the turn, and under the turn each thing that took time', async () => {
    const { response, sink } = await answered();

    expect(response.status).toBe(200);
    /* The reply really was written and the wine really recommended: the trace is of a turn that happened. */
    expect(await response.json()).toMatchObject({
      reply: REPLY,
      recommendations: [{ productId, name: WINE, reason: REASON }],
      outcome: 'ok',
    });
    expect(sink.exports).toHaveLength(1);
    expect(treeOf(sink.spans())).toEqual([
      'http.request',
      'http.request > chat.turn',
      'chat.turn > db.quota',
      'chat.turn > rag.embed',
      'chat.turn > rag.search',
      'chat.turn > db.products',
      'chat.turn > llm.generate',
      'chat.turn > db.record',
    ]);
    expect(new Set(sink.spans().map((span) => span.traceId)).size).toBe(1);
  });

  it('puts the winery and the request on every span of it', async () => {
    const { response, sink } = await answered();
    const requestId = response.headers.get('x-request-id');

    expect(sink.spans()).toHaveLength(8);

    for (const span of sink.spans()) {
      expect(attributesOf(span), span.name).toMatchObject({
        tenant_id: TENANT,
        request_id: requestId,
      });
      /* A member's request has no widget session, and none is invented for it. */
      expect(attributesOf(span), span.name).not.toHaveProperty('session_id');
    }
  });

  it('says of each span what it measured, in numbers and names', async () => {
    const { sink } = await answered();
    const named = (name: string) => attributesOf(sink.spans().find((span) => span.name === name));

    expect(named('http.request')).toMatchObject({
      'http.method': 'POST',
      'http.route': '/v1/dashboard/rag/answer',
      'http.status_code': '200',
    });
    expect(named('chat.turn')).toMatchObject({ 'chat.sandbox': true });
    expect(named('rag.embed')).toMatchObject({ 'rag.model': 'amazon.titan-embed-text-v2:0' });
    /* One statement, so one span: how much each branch found is what tells them apart. */
    expect(named('rag.search')).toMatchObject({
      'rag.vector_hits': '1',
      'rag.lexical_hits': '2',
      'rag.fused': '3',
    });
    expect(named('llm.generate')).toMatchObject({
      /* Which model answered, and that it was the escalated one (P2-28). */
      'llm.model': 'amazon.nova-2-lite-v1:0',
      'llm.tier': 'strong',
      'llm.input_tokens': '900',
      'llm.output_tokens': '60',
      'llm.outcome': 'ok',
    });
  });

  it('says which tier answered a plain question, too', async () => {
    const { sink } = await answered('un rosso');

    expect(attributesOf(sink.spans().find((span) => span.name === 'llm.generate'))).toMatchObject({
      'llm.model': 'amazon.nova-lite-v1:0',
      'llm.tier': 'base',
    });
  });

  it('carries nothing anybody typed and nothing the model wrote', async () => {
    const { sink } = await answered();
    const sent = JSON.stringify(sink.exports);

    /*
     * The phone number by its long run of digits, never by a short one: the
     * export is full of random hex ids and nanosecond timestamps, and "333"
     * turns up in one of those every few runs whatever the code does.
     */
    for (const secret of [
      'Giulia',
      'giulia',
      'Rossi',
      'example.com',
      '1234567',
      'bistecca',
      'Barolo',
      'Monfortino',
      'consiglio',
      'griglia',
      'Conterno',
    ]) {
      expect(sent, secret).not.toContain(secret);
    }

    const attributes = sink.spans().flatMap((span) => span.attributes);

    expect(attributes.length).toBeGreaterThan(20);

    for (const { key, value } of attributes) {
      expect(SPAN_ATTRIBUTES as readonly string[], key).toContain(key);

      /* An identifier, a name of a model, a number: never a sentence, never an address. */
      if ('stringValue' in value) expect(value.stringValue, key).toMatch(/^[^\s@]{1,96}$/u);
    }
  });
});

describe('a visitor’s turn', () => {
  const tenant: WidgetTenant = {
    tenantId: TENANT,
    plan: 'CANTINA',
    status: 'ACTIVE',
    trialEndsAt: null,
    locale: 'it',
    turnstile: false,
    serverSessionsOnly: false,
    originKind: 'production',
  };

  it('has its history read as a span of its own, and a failing model marked where it failed', async () => {
    const sink = collecting();
    const telemetry = createTelemetry({ exporter: sink.exporter, random: () => 0.999 });
    const broken = (): LlmProvider => ({
      id: 'broken',
      // eslint-disable-next-line require-yield -- a stream that raises before it says anything
      streamPairing: async function* () {
        await Promise.resolve();

        throw new Error(`could not answer "${QUESTION}"`);
      },
    });
    const failing = createChatPort({
      embeddings,
      providers: { base: broken, strong: broken },
      models: { base: 'amazon.nova-lite-v1:0', strong: 'amazon.nova-2-lite-v1:0' },
      quota: {
        readUsage: () => Promise.resolve(0),
        readPurchased: () => Promise.resolve(0),
        check: () =>
          Promise.resolve({ allowed: true, state: 'ok', inOverage: false, used: 0, limit: 1_500 }),
      },
    });
    const app = new Hono<AppEnv>();

    app.use('*', requestContext());
    app.use('*', telemetry.middleware());
    app.get('/turn', async (c) => {
      const turn = failing.answer(
        {
          tenant,
          visitor: { sessionId: 'sess-1', origin: 'https://cantina.example', visitorHash: null },
          message: QUESTION,
          signal: new AbortController().signal,
        },
        () => undefined,
      );

      c.set('widgetTenant', tenant);
      c.set('widgetSessionId', 'sess-1');

      try {
        for await (const chunk of turn) void chunk;
      } catch {
        /* The stream's own error handling is the route's; here only the trace is of interest. */
      }

      return c.text('ok');
    });

    await app.request('/turn');

    const spans = sink.spans();
    const generating = spans.find((span) => span.name === 'llm.generate');

    /* Kept although the dice said no: the model raised, and that is not a refusal. */
    expect(sink.exports).toHaveLength(1);
    expect(treeOf(spans)).toEqual([
      'http.request',
      'http.request > db.quota',
      'http.request > rag.embed',
      'http.request > rag.search',
      'http.request > db.products',
      'http.request > db.history',
      'http.request > llm.generate',
      'http.request > db.record',
    ]);
    expect(generating?.status).toEqual({ code: 2 });
    expect(attributesOf(generating)).toMatchObject({
      'error.type': 'Error',
      'llm.outcome': 'provider_error',
      session_id: 'sess-1',
      tenant_id: TENANT,
    });
    /* The error's own words held the question. None of them left. */
    expect(JSON.stringify(sink.exports)).not.toContain('bistecca');
    expect(JSON.stringify(sink.exports)).not.toContain('giulia');
  });
});
