import { randomUUID } from 'node:crypto';

import type { WidgetResolution } from '@catalogorosso/db';
import { memoryRateLimiter } from '@catalogorosso/security';
import {
  generateWidgetTokenKey,
  loadWidgetTokenKeys,
  type WidgetTokenKeys,
} from '@catalogorosso/security/tokens';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { WIDGET_BODY_MAX_BYTES, type WidgetDependencies } from '../src/surfaces/widget.js';
import { MAX_EVENTS, readEventBatch, tokenInBatch } from '../src/widget-events.js';
import {
  WIDGET_TOKEN_AUDIENCE,
  WIDGET_TOKEN_ISSUER,
  WIDGET_TOKEN_TTL_SEC,
} from '../src/widget-token.js';
import { fakeAuth, oneMembership } from './support/auth.js';

/**
 * `POST /v1/widget/events` — the analytics batch (P6-01).
 *
 * **The tenant is the token's, never the body's.** A batch is world-writable
 * from any storefront, so what it may decide is narrow: which of seven things
 * happened, to which of the shop's own wines, and when within reason. The
 * tenant comes from the key and Origin the token is bound to, and the session
 * from the token itself — a body naming either is a body that is not read.
 *
 * **And analytics never breaks the widget**, one layer down: an event that is
 * not one is dropped on its own, and the rest of the batch is kept.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://cantina-rossi.example';
const PATH = '/v1/widget/events';
const PRODUCT = '22222222-2222-4222-8222-222222222222';
const VISITOR = 'visitor-0001';

/** Assembled at runtime, never written as a literal (P0-56). */
const KEY = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

const FOUND: WidgetResolution = {
  found: true,
  tenantId: TENANT,
  status: 'ACTIVE',
  trialEndsAt: null,
  plan: 'CANTINA',
  locale: 'it',
  turnstile: false,
  originKind: 'production',
};

let keys: WidgetTokenKeys;
let token: string;
let sid: string;

const sign = (claims: { origin?: string; sid?: string } = {}) =>
  keys.sign(
    {
      tid: TENANT,
      sid: claims.sid ?? sid,
      origin: claims.origin ?? ORIGIN,
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

beforeAll(async () => {
  keys = await loadWidgetTokenKeys(JSON.stringify({ keys: [await generateWidgetTokenKey('k1')] }));
  sid = randomUUID();
  token = await sign();
});

type Recorder = NonNullable<WidgetDependencies['recordEvents']>;

const recording = () => vi.fn<Recorder>((_tenant, batch) => Promise.resolve(batch.events.length));

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
      sessionCutoffAt: () => Promise.resolve(undefined),
      recordEvents: recording(),
      ...overrides,
    },
  });

const batchOf = (overrides: Record<string, unknown> = {}) => ({
  token,
  visitorId: VISITOR,
  events: [
    { type: 'WIDGET_OPEN', at: Date.now() },
    { type: 'PRODUCT_DETAIL_VIEW', productId: PRODUCT, at: Date.now() },
  ],
  ...overrides,
});

const post = (
  built: ReturnType<typeof appWith>,
  body: unknown = batchOf(),
  headers: Record<string, string> = {},
) =>
  built.request(`${PATH}?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'x-forwarded-for': '203.0.113.7',
      /* What `sendBeacon` sends, and the one type that needs no preflight. */
      'content-type': 'text/plain;charset=UTF-8',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('a batch', () => {
  it('is accepted with 202 and a count of what was kept', async () => {
    const response = await post(appWith());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 2 });
  });

  it('is recorded for the tenant the key and Origin resolved, in the session the token named', async () => {
    const recordEvents = recording();

    await post(appWith({ recordEvents }));

    expect(recordEvents).toHaveBeenCalledTimes(1);
    const [tenantId, batch] = recordEvents.mock.calls[0] ?? [];

    expect(tenantId).toBe(TENANT);
    expect(batch?.widgetSessionId).toBe(sid);
    expect(batch?.visitorId).toBe(VISITOR);
    expect(batch?.events.map((event) => [event.type, event.productId])).toEqual([
      ['WIDGET_OPEN', null],
      ['PRODUCT_DETAIL_VIEW', PRODUCT],
    ]);
  });

  it('decides neither the tenant nor the session, whatever it names (P0-48)', async () => {
    const recordEvents = recording();

    await post(
      appWith({ recordEvents }),
      batchOf({
        tenantId: randomUUID(),
        widgetSessionId: randomUUID(),
        sid: randomUUID(),
      }),
    );

    const [tenantId, batch] = recordEvents.mock.calls[0] ?? [];

    expect(tenantId).toBe(TENANT);
    expect(batch?.widgetSessionId).toBe(sid);
  });

  it('is read as JSON whatever type it says it is', async () => {
    const response = await post(appWith(), batchOf(), { 'content-type': 'application/json' });

    expect(response.status).toBe(202);
  });

  it('keeps the good events when one is not', async () => {
    const recordEvents = recording();
    const response = await post(
      appWith({ recordEvents }),
      batchOf({
        events: [
          { type: 'WIDGET_OPEN', at: Date.now() },
          { type: 'NOT_A_TYPE', at: Date.now() },
          { type: 'CART_OPEN', at: Date.now() },
        ],
      }),
    );

    expect(await response.json()).toEqual({ accepted: 2 });
    expect(recordEvents.mock.calls[0]?.[1].events.map((event) => event.type)).toEqual([
      'WIDGET_OPEN',
      'CART_OPEN',
    ]);
  });

  it('answers with what the store kept, not what was sent', async () => {
    const response = await post(appWith({ recordEvents: () => Promise.resolve(1) }));

    expect(await response.json()).toEqual({ accepted: 1 });
  });
});

describe('the token, which rides in the body', () => {
  it('is required: no token, nothing recorded', async () => {
    const recordEvents = recording();
    const response = await post(appWith({ recordEvents }), batchOf({ token: undefined }));

    expect(response.status).toBe(401);
    expect(recordEvents).not.toHaveBeenCalled();
  });

  it('is read from the body only, so a header alone does not carry a batch', async () => {
    const recordEvents = recording();
    const response = await post(appWith({ recordEvents }), batchOf({ token: undefined }), {
      authorization: `Bearer ${token}`,
    });

    expect(response.status).toBe(401);
    expect(recordEvents).not.toHaveBeenCalled();
  });

  it("is refused when it was minted for another site's Origin", async () => {
    const recordEvents = recording();
    const foreign = await sign({ origin: 'https://evil-example.com' });
    const response = await post(appWith({ recordEvents }), batchOf({ token: foreign }));

    expect(response.status).toBe(401);
    expect(recordEvents).not.toHaveBeenCalled();
  });

  it('is refused when it is not a token', async () => {
    const response = await post(appWith(), batchOf({ token: 'nope' }));

    expect(response.status).toBe(401);
  });

  it('is refused when the body is not JSON at all', async () => {
    const response = await post(appWith(), 'events=1');

    expect(response.status).toBe(401);
  });

  it('is refused when it has been revoked', async () => {
    const recordEvents = recording();
    const response = await post(
      appWith({ recordEvents, isTokenRevoked: () => Promise.resolve(true) }),
    );

    expect(response.status).toBe(401);
    expect(recordEvents).not.toHaveBeenCalled();
  });
});

describe('what is refused before anything is read', () => {
  it('is a body over the widget limit, by its declared length', async () => {
    const recordEvents = recording();
    const response = await post(appWith({ recordEvents }), batchOf(), {
      'content-length': String(WIDGET_BODY_MAX_BYTES + 1),
    });

    expect(response.status).toBe(422);
    expect(recordEvents).not.toHaveBeenCalled();
  });

  it('is a body over the widget limit, by its real size', async () => {
    const recordEvents = recording();
    const response = await post(
      appWith({ recordEvents }),
      batchOf({ padding: 'x'.repeat(WIDGET_BODY_MAX_BYTES) }),
    );

    expect(response.status).toBe(422);
    expect(recordEvents).not.toHaveBeenCalled();
  });

  it('is a body over the limit before its token is read, so it is never parsed', async () => {
    /*
     * The guard reads the token out of the body, which makes it the first
     * thing to read the body at all: unbounded there, a script could make the
     * API parse a megabyte for every invented token.
     */
    const response = await post(
      appWith(),
      batchOf({ token: undefined, padding: 'x'.repeat(WIDGET_BODY_MAX_BYTES) }),
    );

    expect(response.status).toBe(422);
  });

  it('is a key and Origin that do not resolve', async () => {
    const recordEvents = recording();
    const response = await post(
      appWith({
        recordEvents,
        resolve: () => Promise.resolve({ found: false, reason: 'unknown_key' }),
      }),
    );

    expect(response.status).toBe(403);
    expect(recordEvents).not.toHaveBeenCalled();
  });
});

describe('the limit', () => {
  it('is per session, generous, and counted on this endpoint', async () => {
    const built = appWith();
    const statuses: number[] = [];

    for (let sent = 0; sent < 13; sent += 1) statuses.push((await post(built)).status);

    expect(statuses.slice(0, 12)).toEqual(Array.from({ length: 12 }, () => 202));
    expect(statuses[12]).toBe(429);
  });

  it("never spends the winery's minute, which a shopper's question needs", async () => {
    /*
     * A trial winery has thirty requests a minute for everything else. Three
     * visitors browsing, at a dozen batches each, would spend it — and the
     * next page view's config would be refused.
     */
    const built = appWith({ resolve: () => Promise.resolve({ ...FOUND, plan: null }) });

    for (let visitor = 0; visitor < 3; visitor += 1) {
      const own = await sign({ sid: randomUUID() });

      for (let sent = 0; sent < 12; sent += 1) {
        const response = await post(built, batchOf({ token: own }), {
          'x-forwarded-for': `203.0.113.${String(10 + visitor)}`,
        });

        expect(response.status).toBe(202);
      }
    }

    const config = await built.request(`/v1/widget/config?key=${encodeURIComponent(KEY)}`, {
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.99' },
    });

    expect(config.status).toBe(200);
  });

  it('is not the chat limit: six batches leave a question to ask', async () => {
    /*
     * The session's chat limit is six a minute. A batch that counted against
     * it would cost a visitor their next question.
     */
    const built = appWith();

    for (let sent = 0; sent < 7; sent += 1) expect((await post(built)).status).toBe(202);
  });
});

describe('reading a batch', () => {
  const NOW = new Date('2026-10-01T12:00:00.000Z');
  const at = (offsetMs: number) => NOW.getTime() + offsetMs;
  const read = (body: unknown) => readEventBatch(JSON.stringify(body), NOW);
  const envelope = (events: unknown[]) => ({ token: 'a.b.c', visitorId: VISITOR, events });

  it('is nothing when the envelope is not one', () => {
    expect(readEventBatch('not json', NOW)).toBeUndefined();
    expect(read({ visitorId: VISITOR, events: [] })).toBeUndefined();
    expect(read({ token: '', visitorId: VISITOR, events: [] })).toBeUndefined();
    expect(read({ token: 'a.b.c', events: [] })).toBeUndefined();
    expect(read({ token: 'a.b.c', visitorId: VISITOR })).toBeUndefined();
    expect(read({ token: 'a.b.c', visitorId: VISITOR, events: {} })).toBeUndefined();
  });

  it('takes a visitor id that looks like the one the widget makes, and nothing else', () => {
    expect(read({ ...envelope([]), visitorId: randomUUID() })?.visitorId).toBeDefined();
    expect(read({ ...envelope([]), visitorId: 'short' })).toBeUndefined();
    expect(read({ ...envelope([]), visitorId: 'x'.repeat(65) })).toBeUndefined();
    expect(read({ ...envelope([]), visitorId: '<script>alert(1)</script>' })).toBeUndefined();
  });

  it('takes a token of a believable length only', () => {
    expect(read({ ...envelope([]), token: 'x'.repeat(4_096) })).toBeDefined();
    expect(read({ ...envelope([]), token: 'x'.repeat(4_097) })).toBeUndefined();
  });

  it('drops each malformed event on its own, and counts it', () => {
    const batch = read(
      envelope([
        { type: 'WIDGET_OPEN', at: at(0) },
        { type: 'widget_open', at: at(0) },
        { type: 'CART_OPEN' },
        { type: 'ADD_TO_CART', productId: 'not-a-uuid', at: at(0) },
        { type: 'ADD_TO_CART', productId: PRODUCT, at: '2026-10-01' },
        'WIDGET_OPEN',
        null,
        { type: 'ADD_TO_CART', productId: PRODUCT, at: at(0) },
      ]),
    );

    expect(batch?.events.map((event) => event.type)).toEqual(['WIDGET_OPEN', 'ADD_TO_CART']);
    expect(batch?.dropped).toBe(6);
  });

  it('reads no product as no product', () => {
    expect(read(envelope([{ type: 'WIDGET_OPEN', at: at(0) }]))?.events[0]?.productId).toBeNull();
  });

  it(`reads ${String(MAX_EVENTS)} events at most, and counts the rest as dropped`, () => {
    const batch = read(
      envelope(Array.from({ length: MAX_EVENTS + 10 }, () => ({ type: 'WIDGET_OPEN', at: at(0) }))),
    );

    expect(MAX_EVENTS).toBe(50);
    expect(batch?.events).toHaveLength(MAX_EVENTS);
    expect(batch?.dropped).toBe(10);
  });

  it('believes a timestamp up to a day old and five minutes ahead', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const AHEAD = 5 * 60 * 1000;
    const stamps = read(
      envelope(
        [-DAY, -DAY - 1, AHEAD, AHEAD + 1, -1_000].map((offset) => ({
          type: 'WIDGET_OPEN',
          at: at(offset),
        })),
      ),
    )?.events.map((event) => event.at.getTime());

    expect(stamps).toEqual([at(-DAY), NOW.getTime(), at(AHEAD), NOW.getTime(), at(-1_000)]);
  });

  it('stamps an unbelievable one with the time it arrived, rather than dropping it', () => {
    const batch = read(envelope([{ type: 'WIDGET_OPEN', at: 0 }]));

    expect(batch?.events).toHaveLength(1);
    expect(batch?.events[0]?.at).toEqual(NOW);
  });

  it('defaults to the real clock', () => {
    const before = Date.now();
    const batch = readEventBatch(JSON.stringify(envelope([{ type: 'WIDGET_OPEN', at: 0 }])));

    expect(batch?.events[0]?.at.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('the token alone', () => {
  it('is read out of a batch', () => {
    expect(tokenInBatch(JSON.stringify({ token: 'a.b.c', visitorId: VISITOR, events: [] }))).toBe(
      'a.b.c',
    );
  });

  it('is nothing for a body that is not a batch', () => {
    expect(tokenInBatch('{')).toBeUndefined();
    expect(tokenInBatch(JSON.stringify({ token: 'a.b.c' }))).toBeUndefined();
  });
});
