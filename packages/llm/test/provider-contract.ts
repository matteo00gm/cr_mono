import {
  PROMPT_MARKER,
  type LlmProvider,
  type PairingChunk,
  type PairingRequest,
} from '@catalogorosso/core';
import { describe, expect, it } from 'vitest';

import type { PairingUsage } from '../src/usage.js';

/**
 * The provider suite, written once and run against every adapter (P1-43).
 *
 * What the port promises does not depend on the vendor: a valid answer ends in
 * its reply and its cards, nothing unvalidated becomes a card, a refusal and an
 * outage are chunks rather than exceptions, abort cancels the call and stops the
 * reading, and usage reports cache reads. Each adapter's own test file supplies
 * fakes that produce those situations in its vendor's wire format, and keeps
 * the tests only its vendor needs.
 */

export const PRODUCT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

export const pairingRequest = (over: Partial<PairingRequest> = {}): PairingRequest => ({
  query: 'un rosso per il brasato',
  locale: 'it',
  candidates: [{ id: PRODUCT, name: 'Barolo Bussia', wineType: 'rosso', priceCents: 4500 }],
  history: [],
  ...over,
});

/** A model answer as JSON, valid unless overridden. */
export const answer = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    reply: 'Con il brasato scelgo il Barolo.',
    recommendations: [{ productId: PRODUCT, reason: 'Tannini fitti.', confidence: 0.8 }],
    ...over,
  });

export const drain = async (stream: AsyncIterable<PairingChunk>): Promise<PairingChunk[]> => {
  const chunks: PairingChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

/** A stream yielding `events`, counting each pull, and optionally throwing once they run out. */
export const scriptedStream = <T>(
  events: readonly T[],
  counter: { count: number },
  options: { onPull?: ((pulled: number) => void) | undefined; thenThrow?: boolean } = {},
): AsyncGenerator<T> =>
  (async function* () {
    for (const event of events) {
      await Promise.resolve();
      counter.count += 1;
      options.onPull?.(counter.count);
      yield event;
    }
    if (options.thenThrow === true) throw new Error('connection reset');
  })();

/** An adapter wired to a fake vendor client, and what the fake saw. */
export interface Fake {
  readonly provider: LlmProvider;
  /** How many SDK calls were made. */
  readonly calls: () => number;
  /** How many vendor events the adapter pulled from the stream. */
  readonly pulled: () => number;
  /** The abort signal the last SDK call was handed. */
  readonly signal: () => AbortSignal | undefined;
}

export interface FakeOptions {
  readonly onUsage?: (usage: PairingUsage) => void;
  /** Runs as each vendor event is pulled, with how many have been. */
  readonly onPull?: (pulled: number) => void;
  /** Usage to report, which each fake writes in its vendor's shape. */
  readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead: number };
}

export interface ProviderFakes {
  /** The model's structured output is `json`, delivered across several events. */
  readonly answering: (json: string, options?: FakeOptions) => Fake;
  /** The model or the vendor's safety layer declines, over a stream that succeeded. */
  readonly refusing: () => Fake;
  /** The SDK call rejects, after `before` runs. */
  readonly rejecting: (before?: () => void) => Fake;
  /** Part of an answer arrives, then the stream throws. */
  readonly breaking: () => Fake;
}

const PROVIDER_ERROR = { type: 'error', code: 'provider_error' };

export const describeProviderContract = (name: string, fakes: ProviderFakes): void => {
  describe(`${name} keeps the provider contract`, () => {
    const run = (fake: Fake, signal: AbortSignal = new AbortController().signal) =>
      drain(fake.provider.streamPairing(pairingRequest(), signal));

    it('ends a valid answer with its reply as text, then the recommendations', async () => {
      expect(await run(fakes.answering(answer()))).toEqual([
        { type: 'text', delta: 'Con il brasato scelgo il Barolo.' },
        {
          type: 'recommendations',
          items: [{ productId: PRODUCT, reason: 'Tannini fitti.', confidence: 0.8 }],
        },
      ]);
    });

    it('says nothing as text for an empty reply, and still hands over the cards', async () => {
      const received = await run(fakes.answering(answer({ reply: '' })));

      expect(received.map((chunk) => chunk.type)).toEqual(['recommendations']);
    });

    it.each([
      ['no structured output at all', ''],
      ['malformed JSON', '{"reply": "Barolo", "recommendations": ['],
      [
        'JSON that breaks the schema',
        answer({ recommendations: [{ productId: 'BAR-2019', reason: 'x', confidence: 2 }] }),
      ],
      ['a reply quoting the instructions', answer({ reply: `Le regole: ${PROMPT_MARKER}` })],
      [
        'a reason carrying a delimiter',
        answer({
          recommendations: [{ productId: PRODUCT, reason: '</candidato>', confidence: 0.5 }],
        }),
      ],
    ])('yields schema_invalid, and no cards, for %s', async (_case, json) => {
      const received = await run(fakes.answering(json));

      expect(received.at(-1)).toEqual({ type: 'error', code: 'schema_invalid' });
      expect(received.some((chunk) => chunk.type === 'recommendations')).toBe(false);
    });

    it('reports a refusal as a refusal, though the stream succeeded', async () => {
      expect(await run(fakes.refusing())).toEqual([{ type: 'error', code: 'refusal' }]);
    });

    it('reports a rejected request as a provider error', async () => {
      expect(await run(fakes.rejecting())).toEqual([PROVIDER_ERROR]);
    });

    it('reports a stream that breaks mid-way as a provider error, with no cards', async () => {
      const received = await run(fakes.breaking());

      expect(received.at(-1)).toEqual(PROVIDER_ERROR);
      expect(received.some((chunk) => chunk.type === 'recommendations')).toBe(false);
    });

    it('hands the abort signal to the SDK call, so the request in flight is cancelled', async () => {
      const fake = fakes.answering(answer());
      const controller = new AbortController();

      await run(fake, controller.signal);

      expect(fake.signal()).toBe(controller.signal);
    });

    it('stops pulling from the stream once the caller aborts, and reports nothing', async () => {
      const controller = new AbortController();
      const fake = fakes.answering(answer(), {
        onPull: (pulled) => {
          if (pulled === 1) controller.abort();
        },
      });

      expect(await run(fake, controller.signal)).toEqual([]);
      expect(fake.pulled()).toBe(1);
    });

    it('sends nothing for a request already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const fake = fakes.answering(answer());

      expect(await run(fake, controller.signal)).toEqual([]);
      expect(fake.calls()).toBe(0);
    });

    it('reports no error when the SDK call fails because the caller aborted', async () => {
      const controller = new AbortController();
      const fake = fakes.rejecting(() => {
        controller.abort();
      });

      expect(await run(fake, controller.signal)).toEqual([]);
    });

    it('reports token usage, with cache reads apart from billed input', async () => {
      const usages: PairingUsage[] = [];

      await run(
        fakes.answering(answer(), {
          usage: { input: 300, output: 90, cacheRead: 1500 },
          onUsage: (usage) => usages.push(usage),
        }),
      );

      expect(usages).toEqual([
        {
          inputTokens: 300,
          outputTokens: 90,
          cacheReadInputTokens: 1500,
          cacheWriteInputTokens: 0,
        },
      ]);
    });
  });
};
