import { ragAnswerResponse, type WidgetChatEvent } from '@catalogorosso/api-client';
import {
  ConflictError,
  RateLimitedError,
  SANDBOX_ANSWERS_PER_MINUTE,
  SANDBOX_NOT_SERVED,
  SANDBOX_QUOTA_EXCEEDED,
  SANDBOX_TOO_FAST,
  sandboxAnswerLimitKey,
} from '@catalogorosso/core';
import type { ServiceState } from '@catalogorosso/db';
import { memoryRateLimiter, type RateLimiter } from '@catalogorosso/security';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { QuotaExceededError, type ChatPort, type ChatRequest } from '../src/chat.js';
import { logger } from '../src/middleware/logger.js';
import {
  createRagPort,
  RagPortNotConfiguredError,
  SandboxAnsweringNotConfiguredError,
  unconfiguredRag,
  type RagPort,
  type SandboxAnswer,
} from '../src/rag.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * One real answer in the sandbox, on request (P2-37b, Open Decision 8).
 *
 * What the turn itself does — the gate, the bill, what is and is not kept — is
 * the chat port's, asserted in `chat-port.test.ts` and against Postgres in
 * `rag-answer.integration.test.ts`. What is here is what stands in front of
 * it: the ten a minute, the widget's own serving rule, what a refusal says to
 * a seller, and the route.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-10-12T10:00:00Z');

const PAYING: ServiceState = { status: 'ACTIVE', trialEndsAt: null, plan: 'CANTINA', locale: 'it' };

const WINE = {
  name: 'Barolo Monfortino',
  producer: 'Giacomo Conterno',
  vintage: 2019,
  priceCents: 18_500,
  currency: 'EUR',
  imageUrl: null,
  productUrl: null,
  stockStatus: 'IN_STOCK',
  variantId: null,
} as const;

const SPOKEN: readonly WidgetChatEvent[] = [
  { type: 'text', delta: 'Con la bistecca, ' },
  { type: 'text', delta: 'un Barolo.' },
  {
    type: 'recommendations',
    items: [{ productId: 'p1', reason: 'Regge la carne.', confidence: 0.9, product: WINE }],
  },
];

/** A chat port that says exactly this, and remembers what it was asked. */
const speaking = (events: readonly WidgetChatEvent[] = SPOKEN, outcome = 'ok' as const) => {
  const asked: ChatRequest[] = [];
  const chat: ChatPort = {
    answer: (request, onReport) =>
      (async function* () {
        asked.push(request);

        try {
          for (const event of events) yield await Promise.resolve(event);
        } finally {
          onReport({
            outcome,
            escalations: [],
            model: 'amazon.nova-lite-v1:0',
            candidates: 1,
            preCapCount: 1,
            dropped: [],
            redacted: 0,
            locale: 'it',
            localeDetected: true,
            historyDropped: 0,
            leaked: false,
            costMicros: 12,
          });
        }
      })(),
  };

  return { asked, chat };
};

/** A chat port whose stream fails on its first read, before a word of it arrives. */
const failingWith = (error: Error): ChatPort => ({
  answer: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
  }),
});

/** The gate refusing, as the real port's does before anything is spent. */
const atItsCap = (): ChatPort => failingWith(new QuotaExceededError());

const embeddings = {
  model: 'amazon.titan-embed-text-v2:0',
  dim: 4,
  embed: (texts: readonly string[]) => Promise.resolve(texts.map(() => [0.1, 0.2, 0.3, 0.4])),
};

/**
 * A winery whose row is not there. A value of its own: `undefined` handed to a
 * defaulted option is read as "use the default", and would test a paying one.
 */
const GONE = Symbol('gone');

const portWith = ({
  chat = speaking().chat,
  limiter = memoryRateLimiter(() => NOW.getTime()),
  service = PAYING,
}: {
  chat?: ChatPort;
  limiter?: RateLimiter;
  service?: ServiceState | typeof GONE;
} = {}) => {
  const read: string[] = [];
  const port = createRagPort({
    provider: embeddings,
    answering: {
      chat,
      limiter,
      readService: (tenantId) => {
        read.push(tenantId);

        return Promise.resolve(service === GONE ? undefined : service);
      },
      clock: () => NOW,
    },
  });

  return { port, read };
};

const ask = (port: RagPort, tenantId = TENANT, query = 'qualcosa per una bistecca') =>
  port.answer({ tenantId, query, signal: new AbortController().signal });

describe('the answer', () => {
  it('is the reply whole, each wine named from the catalogue, and how the turn ended', async () => {
    const { port } = portWith();

    expect(await ask(port)).toEqual({
      reply: 'Con la bistecca, un Barolo.',
      recommendations: [
        { productId: 'p1', name: 'Barolo Monfortino', reason: 'Regge la carne.', confidence: 0.9 },
      ],
      outcome: 'ok',
    } satisfies SandboxAnswer);
  });

  it('says how a turn with no wines ended, which is what explains it', async () => {
    const { chat } = speaking(
      [
        { type: 'text', delta: 'Non saprei.' },
        { type: 'error', code: 'provider_error' },
      ],
      'provider_error' as never,
    );

    expect(await ask(portWith({ chat }).port)).toEqual({
      reply: 'Non saprei.',
      recommendations: [],
      outcome: 'provider_error',
    });
  });

  it('is asked of the chat port as a turn that is nobody’s, for the winery as the gates read it', async () => {
    const { asked, chat } = speaking();
    const signal = new AbortController().signal;

    await portWith({ chat }).port.answer({ tenantId: TENANT, query: 'un rosso', signal });

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      /* Nobody's: billed, and kept nowhere (`chat-port.test.ts`). */
      visitor: null,
      message: 'un rosso',
      tenant: {
        tenantId: TENANT,
        status: 'ACTIVE',
        trialEndsAt: null,
        plan: 'CANTINA',
        locale: 'it',
      },
    });
    /* The request's own signal: a closed tab stops generation, and what is billed for it. */
    expect(asked[0]?.signal).toBe(signal);
  });
});

describe('ten a minute, per winery', () => {
  it('answers ten and refuses the eleventh before the winery is read or a model asked', async () => {
    const { asked, chat } = speaking();
    const { port, read } = portWith({ chat });

    for (let i = 0; i < SANDBOX_ANSWERS_PER_MINUTE; i += 1) await ask(port);

    await expect(ask(port)).rejects.toThrow(new RateLimitedError(SANDBOX_TOO_FAST));
    expect(SANDBOX_ANSWERS_PER_MINUTE).toBe(10);
    expect(asked).toHaveLength(10);
    expect(read).toHaveLength(10);
  });

  it('counts a winery, not whoever asks — and not another winery', async () => {
    const { port } = portWith();

    for (let i = 0; i < SANDBOX_ANSWERS_PER_MINUTE; i += 1) await ask(port);

    await expect(ask(port)).rejects.toBeInstanceOf(RateLimitedError);
    await expect(ask(port, OTHER)).resolves.toMatchObject({ outcome: 'ok' });
  });

  it('answers again once the minute has passed', async () => {
    let at = NOW.getTime();
    const { port } = portWith({ limiter: memoryRateLimiter(() => at) });

    for (let i = 0; i < SANDBOX_ANSWERS_PER_MINUTE; i += 1) await ask(port);
    await expect(ask(port)).rejects.toBeInstanceOf(RateLimitedError);

    at += 60_000;

    await expect(ask(port)).resolves.toMatchObject({ outcome: 'ok' });
  });

  it('is counted under the winery’s own key, with the limit the row sets', async () => {
    const checked: unknown[] = [];
    const limiter: RateLimiter = {
      check: (checks) => {
        checked.push(...checks);

        return Promise.resolve({
          allowed: true,
          remaining: 9,
          limit: 10,
          resetAt: NOW,
          key: sandboxAnswerLimitKey(TENANT),
        });
      },
    };

    await ask(portWith({ limiter }).port);

    expect(checked).toEqual([{ key: `sandbox:answer:${TENANT}`, limit: 10, windowSec: 60 }]);
  });
});

describe('a winery the widget would not answer for', () => {
  it.each([
    ['has verified no domain yet', { ...PAYING, status: 'PENDING_VERIFICATION', plan: null }],
    ['has a payment that failed', { ...PAYING, status: 'PAST_DUE' }],
    ['is switched off', { ...PAYING, status: 'DISABLED' }],
    [
      'had a trial that ended a moment ago',
      { ...PAYING, status: 'TRIALING', plan: null, trialEndsAt: new Date(NOW.getTime() - 1) },
    ],
  ] as const)('is told so when it %s, and no model is asked', async (_why, service) => {
    const { asked, chat } = speaking();

    await expect(ask(portWith({ chat, service: service as ServiceState }).port)).rejects.toThrow(
      new ConflictError(SANDBOX_NOT_SERVED),
    );
    expect(asked).toEqual([]);
  });

  it('is answered while a trial is still running', async () => {
    const service: ServiceState = {
      ...PAYING,
      status: 'TRIALING',
      plan: null,
      trialEndsAt: new Date(NOW.getTime() + 1),
    };

    await expect(ask(portWith({ service }).port)).resolves.toMatchObject({ outcome: 'ok' });
  });

  it('is not found when the winery is gone', async () => {
    const { asked, chat } = speaking();

    await expect(ask(portWith({ chat, service: GONE }).port)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(asked).toEqual([]);
  });
});

describe('a winery at its cap', () => {
  it('is told so in a seller’s words, with where to do something about it', async () => {
    const refused = ask(portWith({ chat: atItsCap() }).port);

    await expect(refused).rejects.toThrow(new ConflictError(SANDBOX_QUOTA_EXCEEDED));
    expect(SANDBOX_QUOTA_EXCEEDED).toMatch(/tutti i messaggi del mese/u);
    expect(SANDBOX_QUOTA_EXCEEDED).toMatch(/Fatturazione/u);
  });

  it('leaves any other failure exactly what it was', async () => {
    const broken = failingWith(new Error('bedrock is down'));

    await expect(ask(portWith({ chat: broken }).port)).rejects.toThrow('bedrock is down');
  });
});

describe('a port with no way to answer', () => {
  it('still simulates, and says answering is a wiring error rather than answering nothing', async () => {
    const port = createRagPort({ provider: embeddings });

    await expect(ask(port)).rejects.toBeInstanceOf(SandboxAnsweringNotConfiguredError);
  });

  it('refuses both on the stub, as a wiring error', () => {
    expect(() => unconfiguredRag.answer({} as never)).toThrow(RagPortNotConfiguredError);
  });
});

describe('POST /v1/dashboard/rag/answer', () => {
  const PATH = '/v1/dashboard/rag/answer';
  const ANSWER: SandboxAnswer = {
    reply: 'Un Barolo.',
    recommendations: [
      { productId: 'p1', name: 'Barolo Monfortino', reason: 'Regge la carne.', confidence: 0.9 },
    ],
    outcome: 'ok',
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const recording = (answer: RagPort['answer'] = () => Promise.resolve(ANSWER)) => {
    const spy = vi.fn(answer);

    return { answer: spy, port: { ...unconfiguredRag, answer: spy } satisfies RagPort };
  };

  const post = (rag: RagPort, body: unknown, role: 'OWNER' | 'EDITOR' = 'EDITOR') =>
    createApp({ auth: signedIn(), readMemberships: oneMembership(TENANT, role), rag }).request(
      PATH,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
    );

  it('answers a question, in the shape the client parses', async () => {
    const { answer, port } = recording();

    const response = await post(port, { query: '  qualcosa per una bistecca ' });

    expect(response.status).toBe(200);
    expect(ragAnswerResponse.parse(await response.json())).toEqual(ANSWER);
    /* Trimmed, and the winery from the membership (P0-48). */
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, query: 'qualcosa per una bistecca' }),
    );
  });

  it('hands the port the request’s own signal, so a closed tab stops what is billed', async () => {
    const { answer, port } = recording();
    const leaving = new AbortController();

    await createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT),
      rag: port,
    }).request(PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'barolo' }),
      signal: leaving.signal,
    });

    const handed = answer.mock.calls[0]?.[0].signal;

    expect(handed?.aborted).toBe(false);

    leaving.abort();

    expect(handed?.aborted).toBe(true);
  });

  it.each([
    ['nothing to ask', {}],
    ['a blank question', { query: '   ' }],
    ['a question past what a visitor may type', { query: 'x'.repeat(501) }],
    ['a winery of its own (P0-48)', { query: 'barolo', tenantId: OTHER }],
    /* A real turn has no knobs: these are the free simulation's. */
    ['a price ceiling', { query: 'barolo', maxPriceCents: 2_000 }],
    ['a cap', { query: 'barolo', cap: 3 }],
    ['a body that is not JSON', '{'],
  ])('refuses %s, in Italian, without asking anything', async (_what, body) => {
    const { answer, port } = recording();

    const response = await post(port, body);

    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      'Invia un corpo JSON con una query, la domanda da fare.',
    );
    expect(answer).not.toHaveBeenCalled();
  });

  it.each([
    [new RateLimitedError(SANDBOX_TOO_FAST), 429, 'rate_limited'],
    [new ConflictError(SANDBOX_QUOTA_EXCEEDED), 409, 'conflict'],
    [new ConflictError(SANDBOX_NOT_SERVED), 409, 'conflict'],
  ])('tells the seller “%s”', async (refusal, status, code) => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const response = await post(recording(() => Promise.reject(refusal)).port, { query: 'barolo' });

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code, message: refusal.message } });
  });

  it('is not the free simulation: asking that one for an answer asks for nothing', async () => {
    /* "Off unless asked" is the URL. No field on the simulation turns it into a billed call. */
    const { answer, port } = recording();
    const app = createApp({ auth: signedIn(), readMemberships: oneMembership(TENANT), rag: port });
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    for (const body of [
      { query: 'barolo', generate: true },
      { query: 'barolo', answer: true },
    ]) {
      const response = await app.request('/v1/dashboard/rag/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(422);
    }

    expect(answer).not.toHaveBeenCalled();
  });
});
