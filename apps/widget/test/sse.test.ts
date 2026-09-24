import { describe, expect, it } from 'vitest';

import { parseRecords, readEvents, toStreamEvent, type StreamEvent } from '../src/sse.js';

/**
 * Reading the chat stream (P3-06).
 *
 * **The cases that matter are the boundaries.** A network read splits wherever
 * it likes — mid-line, mid-field, mid-character — and a parser that assumed a
 * chunk was a record would work perfectly against a fast local server and fail
 * against a real one, intermittently, for visitors on slow connections.
 *
 * The second is what it refuses: an event neither the server nor this file
 * knows is a version skew, and a widget that guessed at it would render a shape
 * nobody designed.
 */

const NEWLINE = String.fromCharCode(10);
const record = (event: string, data: unknown): string =>
  `event: ${event}${NEWLINE}data: ${JSON.stringify(data)}${NEWLINE}${NEWLINE}`;

/** A body that hands out exactly these chunks, so a split can be put anywhere. */
const streamOf = (...chunks: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let at = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= chunks.length) {
        controller.close();

        return;
      }

      controller.enqueue(encoder.encode(chunks[at]));
      at += 1;
    },
  });
};

const collect = async (body: ReadableStream<Uint8Array>): Promise<StreamEvent[]> => {
  const seen: StreamEvent[] = [];

  for await (const event of readEvents(body)) seen.push(event);

  return seen;
};

describe('splitting the wire into records', () => {
  it('reads a complete record', () => {
    const { events, rest } = parseRecords(record('text', { type: 'text', delta: 'Un ' }));

    expect(events).toEqual([{ event: 'text', data: '{"type":"text","delta":"Un "}' }]);
    expect(rest).toBe('');
  });

  it('keeps a partial record rather than guessing at it', () => {
    /*
     * **The whole hazard.** A blank line is the only thing that ends a record,
     * so a chunk that stops mid-field has to be held until the rest arrives.
     */
    const { events, rest } = parseRecords('event: text' + NEWLINE + 'data: {"type":"te');

    expect(events).toEqual([]);
    expect(rest).toBe('event: text' + NEWLINE + 'data: {"type":"te');
  });

  it('reads several records from one chunk', () => {
    const buffer = record('text', { type: 'text', delta: 'a' }) + record('done', {});

    expect(parseRecords(buffer).events).toHaveLength(2);
  });

  it('ignores the heartbeat comment', () => {
    // P2-29 sends `: keep-alive` every fifteen seconds so an intermediary does
    // not drop an idle connection. It means nothing here.
    const buffer = ': keep-alive' + NEWLINE + NEWLINE + record('done', {});

    expect(parseRecords(buffer).events).toEqual([{ event: 'done', data: '{}' }]);
  });

  it('accepts carriage returns, because a proxy is not ours to assume about', () => {
    const buffer = 'event: done\r\ndata: {}\r\n\r\n';

    expect(parseRecords(buffer).events).toEqual([{ event: 'done', data: '{}' }]);
  });

  it('strips exactly one space after the colon, which is framing', () => {
    const buffer = 'event: text' + NEWLINE + 'data:  two spaces' + NEWLINE + NEWLINE;

    expect(parseRecords(buffer).events[0]?.data).toBe(' two spaces');
  });

  it('joins multi-line data with newlines, as the format says', () => {
    const buffer = 'data: one' + NEWLINE + 'data: two' + NEWLINE + NEWLINE;

    expect(parseRecords(buffer).events[0]?.data).toBe('one' + NEWLINE + 'two');
  });
});

describe('what a record means', () => {
  it('reads a text delta', () => {
    expect(toStreamEvent({ event: 'text', data: '{"type":"text","delta":"Un "}' })).toEqual({
      type: 'text',
      delta: 'Un ',
    });
  });

  it('reads recommendations', () => {
    const items = [{ productId: 'p1', reason: 'tannino', confidence: 0.9 }];

    expect(
      toStreamEvent({
        event: 'recommendations',
        data: JSON.stringify({ type: 'recommendations', items }),
      }),
    ).toEqual({ type: 'recommendations', items });
  });

  it('reads the end of the stream', () => {
    expect(toStreamEvent({ event: 'done', data: '{}' })).toEqual({ type: 'done' });
  });

  it('drops an event neither side knows', () => {
    /*
     * Server and widget are built from one schema (P0-63), so this is a version
     * skew — an older widget against a newer API. Dropping is right; rendering
     * a shape nobody designed is not.
     */
    expect(toStreamEvent({ event: 'sparkle', data: '{"type":"sparkle"}' })).toBeUndefined();
  });

  it('drops data that is not JSON rather than throwing into the page', () => {
    expect(toStreamEvent({ event: 'text', data: 'not json' })).toBeUndefined();
  });

  it('drops JSON that is not an object', () => {
    expect(toStreamEvent({ event: 'text', data: '"a string"' })).toBeUndefined();
    expect(toStreamEvent({ event: 'text', data: 'null' })).toBeUndefined();
  });
});

describe('reading a whole response', () => {
  it('yields the events in the order they were sent', async () => {
    const body = streamOf(
      record('text', { type: 'text', delta: 'Un ' }),
      record('text', { type: 'text', delta: 'Barolo.' }),
      record('recommendations', { type: 'recommendations', items: [] }),
      record('done', {}),
    );

    expect(await collect(body)).toEqual([
      { type: 'text', delta: 'Un ' },
      { type: 'text', delta: 'Barolo.' },
      { type: 'recommendations', items: [] },
      { type: 'done' },
    ]);
  });

  it('survives a record split across two network reads', async () => {
    // The case that works perfectly against a fast local server and fails
    // against a real one, intermittently, for visitors on slow connections.
    const whole = record('text', { type: 'text', delta: 'Un Barolo.' });
    const body = streamOf(whole.slice(0, 14), whole.slice(14), record('done', {}));

    expect(await collect(body)).toEqual([{ type: 'text', delta: 'Un Barolo.' }, { type: 'done' }]);
  });

  it('survives a multi-byte character split across two reads', async () => {
    /*
     * `perché` is two bytes at the accent, and a network read can land between
     * them. A decoder without `stream: true` produces a replacement character,
     * which reaches a visitor as a black diamond in the middle of a word.
     */
    const whole = record('text', { type: 'text', delta: 'perché' });
    const bytes = new TextEncoder().encode(whole);
    const split = whole.indexOf('perch') + 6;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });

    expect(await collect(body)).toEqual([{ type: 'text', delta: 'perché' }]);
  });

  it('reads a last record the server did not terminate', async () => {
    // The server always terminates `done`; a proxy that trimmed the trailing
    // newline would otherwise lose the event that says the answer finished.
    const body = streamOf('event: done' + NEWLINE + 'data: {}');

    expect(await collect(body)).toEqual([{ type: 'done' }]);
  });

  it('yields nothing for an empty body', async () => {
    expect(await collect(streamOf())).toEqual([]);
  });

  it('releases the reader when the caller stops early', async () => {
    /*
     * A visitor who closes the panel mid-answer stops reading. A lock left on
     * the body is a body nothing else can touch — including the abort that
     * should end the request.
     */
    const body = streamOf(record('text', { type: 'text', delta: 'a' }), record('done', {}));

    for await (const first of readEvents(body)) {
      expect(first).toBeDefined();
      break;
    }

    expect(() => body.getReader()).not.toThrow();
  });
});
