import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { allowlistRecommendations } from '../../src/rag/allowlist.js';
import { parsePairingOutput, type PairingOutput } from '../../src/rag/pairing-schema.js';

/**
 * Output allowlisting (P2-25).
 *
 * **P2-26 is the adversarial suite** — crafted outputs, a stubbed provider, a
 * response proven to carry no card for a foreign id. What is here is the
 * function's own behaviour, because a function this load-bearing arriving
 * without tests would be trusted for however long P2-26 takes.
 *
 * The case worth reading is the third one. A wine can belong to this tenant and
 * still be one the model invented for this answer, and an ownership check would
 * admit it. That is why the candidate set is the whole test and not half of it.
 */

const id = (): string => randomUUID();

const output = (...ids: readonly string[]): PairingOutput => ({
  reply: 'Ecco tre bottiglie che stanno bene con una bistecca.',
  recommendations: ids.map((productId, at) => ({
    productId,
    reason: `Motivo ${String(at)}`,
    confidence: 0.8,
  })),
});

const idsOf = (recommendations: readonly { productId: string }[]): string[] =>
  recommendations.map((recommendation) => recommendation.productId);

describe('what reaches a visitor', () => {
  it('keeps a wine that was retrieved for this question', () => {
    const kept = id();

    const result = allowlistRecommendations(output(kept), new Set([kept]));

    expect(idsOf(result.items)).toEqual([kept]);
    expect(result.dropped).toEqual([]);
  });

  it('keeps the order the model ranked them in', () => {
    const [first, second, third] = [id(), id(), id()];

    const result = allowlistRecommendations(
      output(third, first, second),
      new Set([first, second, third]),
    );

    expect(idsOf(result.items)).toEqual([third, first, second]);
  });

  it('passes each recommendation through untouched, reason and confidence included', () => {
    const kept = id();
    const out = output(kept);

    const result = allowlistRecommendations(out, new Set([kept]));

    expect(result.items[0]).toBe(out.recommendations[0]);
  });
});

describe('what is refused', () => {
  it('drops a wine that was never retrieved', () => {
    const invented = id();

    const result = allowlistRecommendations(output(invented), new Set([id()]));

    expect(result.items).toEqual([]);
    expect(idsOf(result.dropped)).toEqual([invented]);
  });

  it('drops a wine from this tenant that was not a candidate', () => {
    /*
     * **The subtle case, and the reason the check is the candidate set rather
     * than the catalogue.** This wine exists, belongs to this winery, and could
     * be looked up and rendered without any query failing — and the model was
     * never given it. An ownership check admits it; there is no way to tell
     * afterwards whether the model retrieved it or invented it.
     */
    const inCatalogueButNotRetrieved = id();
    const retrieved = id();

    const result = allowlistRecommendations(
      output(inCatalogueButNotRetrieved),
      new Set([retrieved]),
    );

    expect(result.items).toEqual([]);
    expect(idsOf(result.dropped)).toEqual([inCatalogueButNotRetrieved]);
  });

  it('drops the invalid ones and keeps the rest', () => {
    const [good, other] = [id(), id()];
    const invented = id();

    const result = allowlistRecommendations(
      output(invented, good, id(), other),
      new Set([good, other]),
    );

    expect(idsOf(result.items)).toEqual([good, other]);
    expect(result.dropped).toHaveLength(2);
  });

  it('drops everything when nothing was retrieved', () => {
    const result = allowlistRecommendations(output(id(), id()), new Set());

    expect(result.items).toEqual([]);
    expect(result.dropped).toHaveLength(2);
  });

  it('drops a repeat of a wine it already kept', () => {
    // Not a security failure — the id is in the set both times — but two
    // identical cards is a visible defect, and this is the one place the list
    // is examined before a visitor sees it.
    const twice = id();

    const result = allowlistRecommendations(output(twice, twice), new Set([twice]));

    expect(idsOf(result.items)).toEqual([twice]);
    expect(result.dropped).toHaveLength(1);
  });
});

describe('answers with no cards', () => {
  it('returns nothing and raises nothing', () => {
    // A reply with no recommendations is a legitimate answer: "nothing here
    // pairs with that". Treating it as an error would turn an honest answer
    // into a failure.
    const result = allowlistRecommendations(output(), new Set([id()]));

    expect(result).toEqual({ items: [], dropped: [] });
  });
});

describe('what it does not do', () => {
  it('leaves the reply alone, because the reply is not its business', () => {
    /*
     * The reply and the reasons are prose nobody can check against anything
     * (P2-23 caps them, P2-27 checks them for leaked instructions). This
     * function checks ids, and pretending otherwise would be the beginning of a
     * second, weaker boundary.
     */
    const kept = id();
    const out = output(kept);

    expect(allowlistRecommendations(out, new Set([kept]))).not.toHaveProperty('reply');
    expect(out.reply).toBe('Ecco tre bottiglie che stanno bene con una bistecca.');
  });

  it('runs on what the schema parsed, so a non-UUID never reaches it', () => {
    // P2-24 refuses anything that is not a UUID, so the allowlist only ever
    // sees well-formed ids. It is the parse that makes an id checkable at all.
    const parsed = parsePairingOutput({
      reply: 'ok',
      recommendations: [{ productId: 'not-a-uuid', reason: 'x', confidence: 0.5 }],
    });

    expect(parsed.ok).toBe(false);
  });
});
