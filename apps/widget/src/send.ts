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
  constructor(readonly status: number) {
    super(`The chat endpoint refused with ${String(status)}.`);
    this.name = 'ChatRefused';
  }
}

/**
 * What a visitor is told when the answer never started.
 *
 * **A 429 is not the monthly cap.** The cap is checked inside the port, after
 * the response has begun, so it arrives as an `error` event with
 * `quota_exceeded` (P2-31) — a status of 429 is the burst limiter instead
 * (P2-04), which is a wait rather than a wall. Both are worth retrying and
 * neither is worth naming to a shopper (§1.3), so both read as `provider`
 * here; P3-07 gives the burst limit its own state and counts down
 * `Retry-After`.
 */
export const failureOf = (error: unknown): ChatFailure =>
  error instanceof ChatRefused ? 'provider' : 'network';

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

  if (!response.ok) throw new ChatRefused(response.status);

  /*
   * A 200 with no body is not something the endpoint does, and a widget that
   * hung waiting for events from `null` would look exactly like one waiting for
   * a slow model.
   */
  if (response.body === null) throw new ChatRefused(response.status);

  yield* readEvents(response.body);
};
