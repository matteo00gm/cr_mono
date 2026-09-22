import { randomUUID } from 'node:crypto';

import type { PairingChunk } from '@catalogorosso/core';
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
const answering = (...chunks: readonly PairingChunk[]): ChatPort => ({
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
          yield await Promise.resolve<PairingChunk>({ type: 'text', delta: 'Un ' });
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
          yield await Promise.resolve<PairingChunk>({ type: 'text', delta: 'Un ' });
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
          yield await Promise.resolve<PairingChunk>({ type: 'text', delta: '' });
          throw new QuotaExceededError();
        })(),
    };

    expect(await (await ask(appWith({ chat: refusing }))).text()).toContain('quota_exceeded');
  });
});

describe('the body it accepts', () => {
  it('reads the message and nothing else (P0-48)', async () => {
    const answer = vi.fn((request: ChatRequest): AsyncIterable<PairingChunk> => ({
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
