import type { WidgetChatEvent } from '@catalogorosso/api-client';

/**
 * Reading the chat stream (P3-06, §4.5).
 *
 * **`fetch` and a `ReadableStream`, never `EventSource`.** `EventSource` cannot
 * send an `Authorization` header, and this design requires one: the session
 * token is origin-bound and goes in that header (P2-12). It also cannot POST,
 * and the visitor's message is a body. Two reasons, either sufficient.
 *
 * **Parsed incrementally, because that is the point.** A stream read whole and
 * then split is a stream in name only — time-to-first-token becomes
 * total-generation-time, which is the failure P2-29's headers exist to prevent
 * at the edge and would be reintroduced here.
 *
 * **A chunk boundary falls anywhere.** A network read can split a line, a
 * field, or a multi-byte character, so the decoder is streaming and the buffer
 * keeps whatever has not yet ended in a newline.
 */

/** What the caller sees: the server's events, plus the end of the stream. */
export type StreamEvent = WidgetChatEvent | { readonly type: 'done' };

/**
 * One `event:`/`data:` pair, as the wire carries it.
 *
 * Exported for the parser's own tests; callers want `readEvents`.
 */
export interface RawEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * Splits a buffer into complete SSE records, returning what is left over.
 *
 * **A record ends at a blank line**, and a blank line is the only thing that
 * ends one — so a partial record at the end of a chunk is kept, not guessed at.
 * A comment line (`:` first) is the heartbeat P2-29 sends every fifteen
 * seconds; it keeps intermediaries from dropping an idle connection and means
 * nothing here.
 */
export const parseRecords = (buffer: string): { events: RawEvent[]; rest: string } => {
  const events: RawEvent[] = [];
  /* `\r\n` and `\n` both, because what a proxy rewrites is not ours to assume. */
  const parts = buffer.split(/\r?\n\r?\n/u);
  const rest = parts.pop() ?? '';

  for (const record of parts) {
    let event = 'message';
    const data: string[] = [];

    for (const line of record.split(/\r?\n/u)) {
      if (line === '' || line.startsWith(':')) continue;

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      /* One optional space after the colon is part of the framing, not the value. */
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '');

      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
    }

    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }

  return { events, rest };
};

/**
 * Turns one record into something the UI can act on, or nothing.
 *
 * **Anything unrecognised is dropped rather than rendered.** The server and
 * this file are built from one schema (P0-63), so an event neither knows is a
 * version skew — and a widget that guessed at it would be rendering a shape
 * nobody designed.
 */
export const toStreamEvent = ({ event, data }: RawEvent): StreamEvent | undefined => {
  if (event === 'done') return { type: 'done' };

  let parsed: unknown;

  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const shape = parsed as { type?: unknown };

  if (shape.type === 'text' || shape.type === 'recommendations' || shape.type === 'error') {
    return parsed as WidgetChatEvent;
  }

  return undefined;
};

/**
 * Reads a response body as a sequence of events.
 *
 * **Yields as they arrive.** The caller appends each `text` delta to what a
 * visitor is already reading, which is the whole reason the endpoint streams.
 *
 * **The reader is released whatever happens.** A caller that stops early — a
 * closed panel, an aborted fetch — must not leave a lock on the body, and a
 * `finally` is what makes that true of a `break` as well as of an exception.
 */
export const readEvents = async function* (
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      /* `stream: true`: a multi-byte character can straddle two network reads. */
      buffer += decoder.decode(value, { stream: true });

      const { events, rest } = parseRecords(buffer);

      buffer = rest;

      for (const raw of events) {
        const event = toStreamEvent(raw);

        if (event !== undefined) yield event;
      }
    }

    /*
     * A stream that ends without a blank line after its last record leaves one
     * in the buffer. The server always sends `done` last and always terminates
     * it — but a proxy that trimmed a trailing newline would otherwise lose the
     * event that tells the widget the answer is finished.
     */
    const { events } = parseRecords(`${buffer}\n\n`);

    for (const raw of events) {
      const event = toStreamEvent(raw);

      if (event !== undefined) yield event;
    }
  } finally {
    reader.releaseLock();
  }
};
