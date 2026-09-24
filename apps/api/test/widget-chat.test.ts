import { randomUUID } from 'node:crypto';

import { widgetChatEvent, type WidgetChatEvent } from '@catalogorosso/api-client';
import type { WidgetResolution } from '@catalogorosso/db';
import { memoryRateLimiter } from '@catalogorosso/security';
import {
  generateWidgetTokenKey,
  loadWidgetTokenKeys,
  type WidgetTokenKeys,
} from '@catalogorosso/security/tokens';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { QuotaExceededError, type ChatPort, type ChatRequest } from '../src/chat.js';
import { SSE_HEADERS, type WidgetDependencies } from '../src/surfaces/widget.js';
import {
  WIDGET_TOKEN_AUDIENCE,
  WIDGET_TOKEN_ISSUER,
  WIDGET_TOKEN_TTL_SEC,
} from '../src/widget-token.js';
import { fakeAuth, oneMembership } from './support/auth.js';

/**
 * `POST /v1/widget/chat` — the surface (P2-29).
 *
 * What the pipeline *does* is asserted where each piece lives: the allowlist in
 * `packages/core`, retrieval against Postgres, the quota against a real ledger.
 * What is asserted here is the response: the events a client reads, the headers
 * that decide whether a stream is a stream, and the two refusals that must not
 * look like an answer.
 *
 * **The one that would be a security bug rather than a defect** is the last:
 * a failure after the first event has no status left to change, so it has to
 * arrive as an event — and it must carry a code of ours rather than whatever
 * the provider said (P0-55).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://cantina-rossi.example';
const PATH = '/v1/widget/chat';

/** Assembled at runtime, never written as a literal (P0-56). */
const KEY = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

const FOUND: WidgetResolution = {
  found: true,
  tenantId: TENANT,
  status: 'ACTIVE',
  plan: 'CANTINA',
  locale: 'it',
};

let keys: WidgetTokenKeys;
let token: string;

beforeAll(async () => {
  keys = await loadWidgetTokenKeys(JSON.stringify({ keys: [await generateWidgetTokenKey('k1')] }));
  token = await keys.sign(
    {
      tid: TENANT,
      sid: randomUUID(),
      origin: ORIGIN,
      plan: 'CANTINA',
      jti: randomUUID(),
      iat_original: Math.floor(Date.now() / 1000),
    },
    {
      issuer: WIDGET_TOKEN_ISSUER,
      audience: WIDGET_TOKEN_AUDIENCE,
      ttlSec: WIDGET_TOKEN_TTL_SEC,
    },
  );
});

/** A chat port that answers with exactly these chunks. */
const answering = (...chunks: readonly WidgetChatEvent[]): ChatPort => ({
  answer: () =>
    (async function* () {
      for (const chunk of chunks) yield await Promise.resolve(chunk);
    })(),
});

const appWith = (overrides: Partial<WidgetDependencies> = {}) =>
  createApp({
    auth: fakeAuth(),
    readMemberships: oneMembership(),
    widget: {
      resolve: () => Promise.resolve(FOUND),
      limiter: memoryRateLimiter(),
      readUsage: () => Promise.resolve(0),
      ipSecret: randomUUID(),
      tokenKeys: () => Promise.resolve(keys),
      isTokenRevoked: () => Promise.resolve(false),
      chat: answering(),
      ...overrides,
    },
  });

const ask = (
  built: ReturnType<typeof appWith>,
  body: unknown = { message: 'qualcosa per una bistecca' },
  headers: Record<string, string> = {},
) =>
  built.request(`${PATH}?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'x-forwarded-for': '203.0.113.7',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** The `data:` payloads in order, as the widget parses them. */
const payloadsOf = (body: string): unknown[] =>
  body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);

/** The `event:` names in order, which is what a client switches on. */
const eventsOf = (body: string): string[] =>
  body
    .split('\n')
    .filter((line) => line.startsWith('event: '))
    .map((line) => line.slice('event: '.length));

describe('the stream', () => {
  it('sends the reply, the cards and then done', async () => {
    const response = await ask(
      appWith({
        chat: answering(
          { type: 'text', delta: 'Con una bistecca ' },
          { type: 'text', delta: 'le consiglio un Barolo.' },
          { type: 'recommendations', items: [] },
        ),
      }),
    );

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(eventsOf(body)).toEqual(['text', 'text', 'recommendations', 'done']);
    expect(body).toContain('Con una bistecca ');
  });

  it('sends nothing the published contract does not name', async () => {
    /*
     * **Strict at every level, and checked against what actually went out.**
     * This stream is world-readable on a storefront, so a field added on the
     * server that the contract does not name — a tenant id, a plan, a stock
     * level — has to fail here rather than quietly reach every visitor of every
     * seller. The same argument P2-10 makes for the config response.
     */
    const response = await ask(
      appWith({
        chat: answering(
          { type: 'text', delta: 'Un Barolo.' },
          {
            type: 'recommendations',
            items: [
              {
                productId: randomUUID(),
                reason: 'tannino deciso',
                confidence: 0.9,
                product: {
                  name: 'Barolo Bussia',
                  producer: 'Cantina Rossi',
                  vintage: 2016,
                  priceCents: 4200,
                  currency: 'EUR',
                  imageUrl: null,
                  productUrl: null,
                  stockStatus: 'IN_STOCK',
                },
              },
            ],
          },
          { type: 'error', code: 'provider_error' },
        ),
      }),
    );

    for (const payload of payloadsOf(await response.text())) {
      /* `done` is the one empty payload, and it is framed by its event name. */
      if (JSON.stringify(payload) === '{}') continue;

      const parsed = widgetChatEvent.safeParse(payload);

      expect(parsed.error?.message ?? 'ok', JSON.stringify(payload)).toBe('ok');
    }
  });

  it('refuses a card field the contract does not name', async () => {
    /*
     * **The strictness is the test, because nothing re-validates outbound.**
     * The port is typed, so an extra field is a type error in our own code —
     * what this pins is the *published* contract: `additionalProperties: false`
     * is what a widget author reads in `openapi.json`, and a schema that
     * quietly accepted an unknown key would be promising something else.
     */
    const response = await ask(
      appWith({
        chat: answering({
          type: 'recommendations',
          items: [
            {
              productId: randomUUID(),
              reason: 'tannino deciso',
              confidence: 0.9,
              product: {
                name: 'Barolo Bussia',
                producer: null,
                vintage: null,
                priceCents: 4200,
                currency: 'EUR',
                imageUrl: null,
                productUrl: null,
                stockStatus: 'IN_STOCK',
                /* The field nobody should have added. */
                stockQty: 3,
              },
            },
          ],
        } as unknown as WidgetChatEvent),
      }),
    );

    const cards = payloadsOf(await response.text()).filter(
      (payload) => (payload as { type?: string }).type === 'recommendations',
    );

    expect(cards).toHaveLength(1);
    expect(widgetChatEvent.safeParse(cards[0]).success).toBe(false);
  });

  it('always ends with done, so a client knows an answer finished', async () => {
    // Without it a finished answer and a dropped connection look identical, and
    // the widget shows a spinner over a complete reply.
    const response = await ask(appWith({ chat: answering() }));

    expect(eventsOf(await response.text())).toEqual(['done']);
  });

  it('carries the four headers that decide whether a stream is a stream', async () => {
    /*
     * `no-transform` is the load-bearing one: it tells CloudFront not to
     * compress the body, and compression is itself a buffering step. A buffered
     * stream is indistinguishable from a slow one, so time-to-first-token
     * silently becomes total-generation-time.
     */
    const response = await ask(appWith());

    for (const [header, value] of Object.entries(SSE_HEADERS)) {
      expect(response.headers.get(header)?.toLowerCase()).toContain(value.toLowerCase());
    }
  });
});

describe('a failure after the first event', () => {
  it('arrives as an error event rather than truncating silently', async () => {
    /*
     * The response has already begun, so there is no status left to change. A
     * truncated stream is indistinguishable from a finished one, which is the
     * worst of the three ways this can end.
     */
    const failing: ChatPort = {
      answer: () =>
        (async function* () {
          yield await Promise.resolve<WidgetChatEvent>({ type: 'text', delta: 'Un ' });
          throw new Error('the provider fell over');
        })(),
    };

    const body = await (await ask(appWith({ chat: failing }))).text();

    expect(eventsOf(body)).toEqual(['text', 'error', 'done']);
    expect(body).toContain('provider_error');
  });

  it('never carries the provider own words to a visitor', async () => {
    // A driver's or a vendor's message can hold a connection string or another
    // tenant's data (P0-55). The code is ours; the message is not forwarded.
    const failing: ChatPort = {
      answer: () =>
        (async function* () {
          yield await Promise.resolve<WidgetChatEvent>({ type: 'text', delta: 'Un ' });
          throw new Error('postgres://user:pw@host/db is unreachable');
        })(),
    };

    const body = await (await ask(appWith({ chat: failing }))).text();

    expect(body).not.toContain('postgres://');
    expect(body).not.toContain('unreachable');
  });

  it('says the month is spent when that is what stopped it', async () => {
    const refusing: ChatPort = {
      answer: () =>
        (async function* () {
          yield await Promise.resolve<WidgetChatEvent>({ type: 'text', delta: '' });
          throw new QuotaExceededError();
        })(),
    };

    expect(await (await ask(appWith({ chat: refusing }))).text()).toContain('quota_exceeded');
  });
});

describe('the body it accepts', () => {
  it('reads the message and nothing else (P0-48)', async () => {
    const answer = vi.fn((request: ChatRequest): AsyncIterable<WidgetChatEvent> => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.resolve({ done: true as const, value: undefined, seen: request.message }),
      }),
    }));

    await ask(appWith({ chat: { answer } }), { message: 'un rosso' });

    const [request] = answer.mock.calls[0] ?? [];

    expect(request?.message).toBe('un rosso');
    expect(request?.tenant.tenantId).toBe(TENANT);
    /* The session comes from the token, never from the body (P0-48). */
    expect(request?.sessionId).toEqual(expect.any(String));
  });

  it('refuses a body offering a tenant of its own', async () => {
    // `.strict()`: the tenant comes from the key and the Origin, so a body
    // carrying one is a caller trying something rather than a client sending
    // too much.
    const answer = vi.fn();

    const response = await ask(appWith({ chat: { answer } }), {
      message: 'un rosso',
      tenantId: '22222222-2222-4222-8222-222222222222',
    });

    expect(response.status).toBe(422);
    expect(answer).not.toHaveBeenCalled();
  });

  it('refuses an empty message', async () => {
    expect((await ask(appWith(), { message: '   ' })).status).toBe(422);
  });

  it('refuses a message longer than the model reads', async () => {
    expect((await ask(appWith(), { message: 'a'.repeat(501) })).status).toBe(422);
  });

  it('refuses a body that is not JSON at all', async () => {
    const built = appWith();
    const response = await built.request(`${PATH}?key=${encodeURIComponent(KEY)}`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'x-forwarded-for': '203.0.113.7',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: 'not json',
    });

    expect(response.status).toBe(422);
  });
});

describe('what it will not answer', () => {
  it('refuses without a token, before the port is reached', async () => {
    /*
     * A visitor with no session is a script. The port is never called, so a
     * refusal here costs no query and no model call — which is the same
     * argument P2-04 makes about resolving a key.
     */
    const answer = vi.fn();
    const built = appWith({ chat: { answer } });

    const response = await built.request(`${PATH}?key=${encodeURIComponent(KEY)}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'un rosso' }),
    });

    expect(response.status).toBe(401);
    expect(answer).not.toHaveBeenCalled();
  });

  it('refuses an unwired port loudly rather than streaming nothing', async () => {
    // A widget that streams nothing and errors nothing is a widget nobody can
    // debug — and looks exactly like a shop with no wines.
    const response = await ask(appWith({ chat: undefined }));

    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});
