import { describe, expect, it, vi } from 'vitest';

import { ask, ChatRefused, CHAT_PATH, failureOf, FALLBACK_RETRY_AFTER } from '../src/send.js';
import type { StreamEvent } from '../src/sse.js';

/**
 * Asking the question (P3-06).
 *
 * **Most of this file is about the request, not the answer.** Reading the
 * stream is `sse.test.ts`; what is here is the handful of decisions a browser
 * enforces and a mistake in which fails in a way no unit test of the parser
 * would ever see — a missing `Authorization` header, a cookie that makes CORS
 * refuse the whole request, a body the route cannot parse.
 */

const API = 'https://api.example';
const KEY = 'pk_test_abc';
const TOKEN = 'header.payload.signature';
const NEWLINE = String.fromCharCode(10);

const body = (...records: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const record of records) controller.enqueue(encoder.encode(record));
      controller.close();
    },
  });
};

const record = (event: string, data: unknown): string =>
  `event: ${event}${NEWLINE}data: ${JSON.stringify(data)}${NEWLINE}${NEWLINE}`;

const responding = (
  stream: ReadableStream<Uint8Array> | null = body(record('done', {})),
  init: ResponseInit = {},
): ReturnType<typeof vi.fn> => vi.fn(() => Promise.resolve(new Response(stream, init)));

const asking = (fetch_: typeof globalThis.fetch): AsyncGenerator<StreamEvent> =>
  ask({
    api: API,
    key: KEY,
    token: TOKEN,
    message: 'Che vino?',
    signal: new AbortController().signal,
    fetch: fetch_,
  });

const drain = async (events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> => {
  const seen: StreamEvent[] = [];

  for await (const event of events) seen.push(event);

  return seen;
};

const requestOf = (fetch_: ReturnType<typeof vi.fn>): RequestInit =>
  (fetch_.mock.calls[0]?.[1] ?? {}) as RequestInit;

const headerOf = (fetch_: ReturnType<typeof vi.fn>, name: string): string | undefined =>
  (requestOf(fetch_).headers as Record<string, string> | undefined)?.[name];

describe('the request', () => {
  it('carries the session token, which is why this is not an EventSource', async () => {
    /*
     * The whole reason for `fetch` + `ReadableStream`: the token is origin-bound
     * and goes in this header (P2-12), and `EventSource` cannot send one.
     */
    const fetch_ = responding();

    await drain(asking(fetch_ as unknown as typeof globalThis.fetch));

    expect(headerOf(fetch_, 'authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('posts the message as the body, which EventSource also cannot do', async () => {
    const fetch_ = responding();

    await drain(asking(fetch_ as unknown as typeof globalThis.fetch));

    expect(requestOf(fetch_).method).toBe('POST');
    expect(requestOf(fetch_).body).toBe(JSON.stringify({ message: 'Che vino?' }));
  });

  it('sends no cookies, because this surface refuses them', async () => {
    /* P2-08 answers `Access-Control-Allow-Credentials: false`, so asking makes
     * the browser refuse the whole request for a reason nobody would guess. */
    const fetch_ = responding();

    await drain(asking(fetch_ as unknown as typeof globalThis.fetch));

    expect(requestOf(fetch_).credentials).toBe('omit');
  });

  it('names the key in the query, where the guards look for it', async () => {
    const fetch_ = responding();

    await drain(asking(fetch_ as unknown as typeof globalThis.fetch));

    expect(fetch_.mock.calls[0]?.[0]).toBe(`${API}${CHAT_PATH}?key=${KEY}`);
  });

  it('escapes a key rather than pasting it into a URL', async () => {
    const fetch_ = responding();

    await drain(
      ask({
        api: API,
        key: 'a&b=c',
        token: TOKEN,
        message: 'Che vino?',
        signal: new AbortController().signal,
        fetch: fetch_ as unknown as typeof globalThis.fetch,
      }),
    );

    expect(fetch_.mock.calls[0]?.[0]).toBe(`${API}${CHAT_PATH}?key=a%26b%3Dc`);
  });

  it('passes the abort signal down, so closing the tab stops generation', async () => {
    const controller = new AbortController();
    const fetch_ = responding();

    await drain(
      ask({
        api: API,
        key: KEY,
        token: TOKEN,
        message: 'Che vino?',
        signal: controller.signal,
        fetch: fetch_ as unknown as typeof globalThis.fetch,
      }),
    );

    expect(requestOf(fetch_).signal).toBe(controller.signal);
  });

  it('asks for a stream', async () => {
    const fetch_ = responding();

    await drain(asking(fetch_ as unknown as typeof globalThis.fetch));

    expect(headerOf(fetch_, 'accept')).toBe('text/event-stream');
  });
});

describe('the answer', () => {
  it('yields the events the server sent', async () => {
    const fetch_ = responding(
      body(record('text', { type: 'text', delta: 'Un Barolo.' }), record('done', {})),
    );

    expect(await drain(asking(fetch_ as unknown as typeof globalThis.fetch))).toEqual([
      { type: 'text', delta: 'Un Barolo.' },
      { type: 'done' },
    ]);
  });
});

describe('a refusal', () => {
  it('throws before a single event is read', async () => {
    /*
     * A status is the whole of what a refusal is. Once the stream has begun
     * there is none left to change, which is why a mid-stream failure arrives
     * as an `error` event instead (P2-29).
     */
    const fetch_ = responding(body(), { status: 429 });

    await expect(drain(asking(fetch_ as unknown as typeof globalThis.fetch))).rejects.toThrow(
      ChatRefused,
    );
  });

  it('carries the status, because the caller tells them apart', async () => {
    const fetch_ = responding(body(), { status: 401 });

    await expect(drain(asking(fetch_ as unknown as typeof globalThis.fetch))).rejects.toMatchObject(
      { status: 401 },
    );
  });

  it('refuses a 200 with no body rather than waiting forever', async () => {
    /* A widget hanging on events from `null` looks exactly like one waiting for
     * a slow model, which is the worst way for this to fail. */
    const fetch_ = responding(null, { status: 200 });

    await expect(drain(asking(fetch_ as unknown as typeof globalThis.fetch))).rejects.toThrow(
      ChatRefused,
    );
  });
});

describe('what a visitor is told', () => {
  it('treats a refusal as the shop being unable to answer', () => {
    expect(failureOf(new ChatRefused(503))).toEqual({ k: 'error', cause: 'provider' });
  });

  it('does not call a burst limit a spent month', () => {
    /*
     * The monthly cap is checked inside the port, after the response has begun,
     * so it arrives as an `error` event with `quota_exceeded` (P2-31). A 429
     * status is the burst limiter (P2-04) — a wait, not a wall — and telling a
     * visitor their month is over would be wrong and unhelpful at once.
     */
    expect(failureOf(new ChatRefused(429, 12))).toEqual({ k: 'rateLimited', retryAfter: 12 });
  });

  it('treats anything that is not a refusal as the connection', () => {
    expect(failureOf(new TypeError('Failed to fetch'))).toEqual({ k: 'error', cause: 'network' });
  });

  it('waits a sensible default when Retry-After never arrived', () => {
    /* Cross-origin the header is readable only because CORS exposes it (P2-08).
     * A deployment that stopped would otherwise produce a countdown from NaN. */
    expect(failureOf(new ChatRefused(429))).toEqual({
      k: 'rateLimited',
      retryAfter: FALLBACK_RETRY_AFTER,
    });
  });
});

describe('how long to wait', () => {
  const refusalFrom = async (headers: Record<string, string>): Promise<ChatRefused> => {
    const fetch_ = responding(body(), { status: 429, headers });

    try {
      await drain(asking(fetch_ as unknown as typeof globalThis.fetch));
    } catch (error) {
      return error as ChatRefused;
    }

    throw new Error('The refusal did not throw.');
  };

  it('reads Retry-After from the response', async () => {
    expect((await refusalFrom({ 'retry-after': '17' })).retryAfter).toBe(17);
  });

  it('rounds a fractional wait up, because waiting too little is another 429', async () => {
    expect((await refusalFrom({ 'retry-after': '2.2' })).retryAfter).toBe(3);
  });

  it('falls back when the header is an HTTP date it will not guess at', async () => {
    /* Our limiter sends seconds (P2-04). Parsing a date against a visitor's own
     * clock is how a countdown ends up at minus four hours. */
    expect((await refusalFrom({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })).retryAfter).toBe(
      FALLBACK_RETRY_AFTER,
    );
  });

  it('falls back when the header is missing entirely', async () => {
    expect((await refusalFrom({})).retryAfter).toBe(FALLBACK_RETRY_AFTER);
  });
});
