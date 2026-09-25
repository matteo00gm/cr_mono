import type { ChatFailure } from './conversation.js';
import { readEvents, type StreamEvent } from './sse.js';

/**
 * Asking the question (P3-06, §3.4).
 *
 * **`fetch`, not `EventSource`**, and the reason is in the request rather than
 * the response: the session token is origin-bound and goes in an
 * `Authorization` header (P2-12), which `EventSource` cannot send — and the
 * visitor's message is a body, which it cannot post either.
 *
 * **`credentials: 'omit'`**, because this surface accepts no cookies (P2-08)
 * and asking is how CORS fails for a reason nobody reading this would guess.
 *
 * **The token is held by the caller, in memory.** Not here, not in storage
 * (P3-16): this function takes one and forgets it, so there is no place in the
 * module graph where a token outlives the request that used it.
 */

/** Where P2-29's chat lives, relative to the API origin the loader captured. */
export const CHAT_PATH = '/v1/widget/chat';

export interface AskOptions {
  readonly api: string;
  readonly key: string;
  readonly token: string;
  readonly message: string;
  /** Aborted when the visitor closes the panel, which stops generation and stops billing. */
  readonly signal: AbortSignal;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/** A refusal the caller has to tell apart, because the visitor is told something different. */
export class ChatRefused extends Error {
  constructor(
    readonly status: number,
    /** Seconds, from `Retry-After`. Present on a 429, which is the one the visitor waits out. */
    readonly retryAfter?: number,
    /**
     * The `error.code` the body carried, when it carried one.
     *
     * `unavailable` is the one that matters: a winery that has lapsed renders
     * *disabled* rather than *error*, because a retry button that can never
     * succeed turns an invoice into a support ticket (§1.3, P3-21).
     */
    readonly code?: string,
  ) {
    super(`The chat endpoint refused with ${String(status)}.`);
    this.name = 'ChatRefused';
  }
}

/** True when the refusal means the winery is not serving, rather than that we broke. */
export const isLapsed = (error: unknown): boolean =>
  error instanceof ChatRefused && error.code === 'unavailable';

/** The default wait when a 429 arrives without a readable `Retry-After`. */
export const FALLBACK_RETRY_AFTER = 30;

/**
 * Reads `Retry-After` as seconds.
 *
 * **Cross-origin, this header is readable only because CORS says so** — the
 * widget surface names it in `Access-Control-Expose-Headers` (P2-08). A
 * deployment that stopped exposing it would leave this `undefined` rather than
 * throwing, which is why there is a fallback rather than an assumption.
 *
 * The HTTP-date form of the header is not parsed. Our limiter sends seconds
 * (P2-04), and guessing at a date against a visitor's own clock would produce
 * countdowns of minus four hours.
 */
const retryAfterIn = (header: string | null): number => {
  const seconds = Number(header);

  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : FALLBACK_RETRY_AFTER;
};

/**
 * What a visitor is told when the answer never started.
 *
 * **A 429 is not the monthly cap.** The cap is checked inside the port, after
 * the response has begun, so it arrives as an `error` event with
 * `quota_exceeded` (P2-31) — a status of 429 is the burst limiter instead
 * (P2-04), which is a wait rather than a wall. It gets P3-07's `rateLimited`
 * state and a countdown; every other refusal is the shop being unable to
 * answer, and anything that is not a refusal never reached the shop at all.
 */
export const failureOf = (error: unknown): ChatFailure => {
  if (!(error instanceof ChatRefused)) return { k: 'error', cause: 'network' };

  if (error.status === 429) {
    return { k: 'rateLimited', retryAfter: error.retryAfter ?? FALLBACK_RETRY_AFTER };
  }

  return { k: 'error', cause: 'provider' };
};

/** The `error.code` a refusal carried, read defensively: a 502 is not our shape. */
const codeIn = async (response: Response): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };

    return typeof body.error?.code === 'string' ? body.error.code : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Sends one message and yields the answer as it arrives.
 *
 * **A refusal throws before any event is read**, because a status is the whole
 * of what a refusal is: 401 means the session has lapsed and P3-21 will mint a
 * new one, 429 means the burst limit. Once the stream has begun there is no
 * status left to change, and a failure arrives as an `error` event instead
 * (P2-29) — which is why this throws only here and never after.
 */
export const ask = async function* ({
  api,
  key,
  token,
  message,
  signal,
  fetch: fetch_ = globalThis.fetch,
}: AskOptions): AsyncGenerator<StreamEvent> {
  const response = await fetch_(`${api}${CHAT_PATH}?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    credentials: 'omit',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    throw new ChatRefused(
      response.status,
      retryAfterIn(response.headers.get('retry-after')),
      await codeIn(response),
    );
  }

  /*
   * A 200 with no body is not something the endpoint does, and a widget that
   * hung waiting for events from `null` would look exactly like one waiting for
   * a slow model.
   */
  if (response.body === null) throw new ChatRefused(response.status);

  yield* readEvents(response.body);
};
