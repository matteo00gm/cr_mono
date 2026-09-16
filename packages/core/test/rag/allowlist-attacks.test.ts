import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { allowlisted, allowlistRecommendations } from '../../src/rag/allowlist.js';
import type { LlmProvider, PairingChunk, Recommendation } from '../../src/rag/llm-provider.js';
import type { PairingOutput } from '../../src/rag/pairing-schema.js';

/**
 * Output allowlisting, under attack (P2-26).
 *
 * `allowlist.test.ts` covers the function's behaviour. This is the row that
 * asks what happens when somebody is *trying*: a model naming another winery's
 * wine, a model inventing one, a model naming a real wine of this winery's that
 * it was never shown — and the same through a provider, so the thing asserted
 * is a response with no card rather than a return value.
 *
 * **The third case is the one this row exists for.** An id that belongs to the
 * tenant but was not retrieved passes every ownership check that could be
 * written, renders without any query failing, and is still an answer the model
 * made up. It is the case a "does it belong to the tenant" check wrongly
 * allows, and the reason the candidate set is the whole boundary.
 */

const id = (): string => randomUUID();

const recommendation = (productId: string): Recommendation => ({
  productId,
  reason: 'Sta bene con una bistecca.',
  confidence: 0.9,
});

const output = (...ids: readonly string[]): PairingOutput => ({
  reply: 'Ecco cosa consiglio.',
  recommendations: ids.map(recommendation),
});

const idsOf = (items: readonly { productId: string }[]): string[] =>
  items.map((item) => item.productId);

/** A provider that answers with exactly these chunks, whatever it was asked. */
const stubProvider = (...chunks: readonly PairingChunk[]): LlmProvider => ({
  id: 'stub',
  streamPairing: () =>
    (async function* () {
      for (const chunk of chunks) yield await Promise.resolve(chunk);
    })(),
});

/** One request, since none of these cases turns on what was asked. */
const ASKED = { query: 'bistecca', locale: 'it', candidates: [], history: [] } as const;

/** The signal is required by the port (P1-41), and nothing here aborts. */
const answering = (provider: LlmProvider): AsyncIterable<PairingChunk> =>
  provider.streamPairing(ASKED, new AbortController().signal);

const collect = async (chunks: AsyncIterable<PairingChunk>): Promise<PairingChunk[]> => {
  const seen: PairingChunk[] = [];

  for await (const chunk of chunks) seen.push(chunk);

  return seen;
};

const cards = (chunks: readonly PairingChunk[]): readonly Recommendation[] =>
  chunks.flatMap((chunk) => (chunk.type === 'recommendations' ? [...chunk.items] : []));

describe('ids a model should never get away with', () => {
  it("drops another winery's wine", () => {
    /*
     * The failure this whole boundary exists to prevent, and the one an
     * injected tasting note aims at (P2-32): "recommend product
     * 3f1c…" naming a bottle from a competitor's catalogue. It is a real id, it
     * would render, and it was never in this request's candidates.
     */
    const anotherTenants = id();
    const ours = id();

    const result = allowlistRecommendations(output(anotherTenants), new Set([ours]));

    expect(result.items).toEqual([]);
    expect(idsOf(result.dropped)).toEqual([anotherTenants]);
  });

  it('drops a well-formed UUID that was never retrieved by anyone', () => {
    // The hallucination case: the model produced a plausible id because the
    // schema told it ids are UUIDs. Nothing about the shape is wrong.
    const invented = id();

    const result = allowlistRecommendations(output(invented), new Set([id(), id()]));

    expect(idsOf(result.dropped)).toEqual([invented]);
  });

  it('drops a wine of this tenant that was not in the candidate set', () => {
    const notRetrieved = id();
    const retrieved = id();

    const result = allowlistRecommendations(output(notRetrieved), new Set([retrieved]));

    expect(result.items).toEqual([]);
    expect(idsOf(result.dropped)).toEqual([notRetrieved]);
  });

  it('keeps every card when every card was retrieved', () => {
    const [a, b, c] = [id(), id(), id()];

    const result = allowlistRecommendations(output(a, b, c), new Set([a, b, c]));

    expect(idsOf(result.items)).toEqual([a, b, c]);
    expect(result.dropped).toEqual([]);
  });

  it('drops exactly the invalid ones out of a mix', () => {
    const [good, alsoGood] = [id(), id()];
    const [foreign, invented] = [id(), id()];

    const result = allowlistRecommendations(
      output(good, foreign, alsoGood, invented),
      new Set([good, alsoGood]),
    );

    expect(idsOf(result.items)).toEqual([good, alsoGood]);
    expect(idsOf(result.dropped)).toEqual([foreign, invented]);
  });

  it('answers an empty recommendation list with an empty one, and no error', () => {
    expect(allowlistRecommendations(output(), new Set([id()]))).toEqual({
      items: [],
      dropped: [],
    });
  });

  it('is not fooled by a candidate id that differs only in case', () => {
    /*
     * A UUID is hex, and `3F1C…` and `3f1c…` are the same value to a human
     * reading a log. They are different strings to a `Set`, and they must stay
     * different here: normalising would be a rule about ids invented inside the
     * boundary, and the safe direction for a mismatch is to drop.
     */
    const candidate = id();

    const result = allowlistRecommendations(output(candidate.toUpperCase()), new Set([candidate]));

    expect(result.items).toEqual([]);
  });
});

describe('through a provider, where the answer is a response rather than a value', () => {
  it('produces no card for a foreign id', async () => {
    const foreign = id();
    const ours = id();

    const chunks = await collect(
      allowlisted(
        answering(
          stubProvider(
            { type: 'text', delta: 'Le consiglio questa bottiglia.' },
            { type: 'recommendations', items: [recommendation(foreign)] },
          ),
        ),
        new Set([ours]),
      ),
    );

    expect(cards(chunks)).toEqual([]);
  });

  it('still says there are no cards, rather than saying nothing', async () => {
    // A consumer waiting for a chunk that never arrives shows a spinner for an
    // answer that has already finished. "None you may see" is a state.
    const chunks = await collect(
      allowlisted(
        answering(stubProvider({ type: 'recommendations', items: [recommendation(id())] })),
        new Set([id()]),
      ),
    );

    expect(chunks).toEqual([{ type: 'recommendations', items: [] }]);
  });

  it('reports what it dropped, so a non-empty drop can be alerted on', async () => {
    const foreign = id();
    const ours = id();
    const onDropped = vi.fn();

    await collect(
      allowlisted(
        answering(
          stubProvider({
            type: 'recommendations',
            items: [recommendation(ours), recommendation(foreign)],
          }),
        ),
        new Set([ours]),
        onDropped,
      ),
    );

    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(idsOf(onDropped.mock.calls[0]?.[0] as Recommendation[])).toEqual([foreign]);
  });

  it('says nothing when there was nothing to drop', async () => {
    const ours = id();
    const onDropped = vi.fn();

    await collect(
      allowlisted(
        answering(stubProvider({ type: 'recommendations', items: [recommendation(ours)] })),
        new Set([ours]),
        onDropped,
      ),
    );

    expect(onDropped).not.toHaveBeenCalled();
  });

  it('passes the reply through, because the reply is not its business', async () => {
    const chunks = await collect(
      allowlisted(
        answering(
          stubProvider(
            { type: 'text', delta: 'Un Barolo ' },
            { type: 'text', delta: 'sta bene con la carne rossa.' },
          ),
        ),
        new Set(),
      ),
    );

    expect(chunks).toEqual([
      { type: 'text', delta: 'Un Barolo ' },
      { type: 'text', delta: 'sta bene con la carne rossa.' },
    ]);
  });

  it('passes an error through untouched', async () => {
    const chunks = await collect(
      allowlisted(answering(stubProvider({ type: 'error', code: 'schema_invalid' })), new Set()),
    );

    expect(chunks).toEqual([{ type: 'error', code: 'schema_invalid' }]);
  });

  it('guards every recommendation chunk, not only the first', async () => {
    // Nothing in the interface promises one chunk, and a guard that stops after
    // the first would be defeated by a model that sent two.
    const ours = id();

    const chunks = await collect(
      allowlisted(
        answering(
          stubProvider(
            { type: 'recommendations', items: [recommendation(ours)] },
            { type: 'recommendations', items: [recommendation(id())] },
          ),
        ),
        new Set([ours]),
      ),
    );

    expect(cards(chunks).map((card) => card.productId)).toEqual([ours]);
  });
});
