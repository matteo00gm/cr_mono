import type { PairingChunk, Recommendation } from './llm-provider.js';
import type { PairingOutput } from './pairing-schema.js';

/**
 * Output allowlisting (P2-25, §3.7).
 *
 * **This is the boundary that makes a hallucinated or cross-tenant wine
 * structurally unable to reach a visitor.** Everything a model returns is
 * untrusted: it can name a product that does not exist, one belonging to
 * another winery, or one it was told to name by text a seller pasted into a
 * tasting note (P2-32). The reply and the reasons are prose nobody can check;
 * the ids are the one part that can be, and this is where they are.
 *
 * **Membership in the candidate set is sufficient *and* necessary**, which is
 * the whole design. The candidates were retrieved under `withTenant` with an
 * explicit tenant predicate (P2-18), so an id in the set is already a wine this
 * tenant owns — there is nothing a second check could establish.
 *
 * **So it does not re-query to "double check" ownership.** That would cost a
 * round trip on the hot path, and it would do something worse: it would invite
 * a later change to relax the set check on the grounds that the query covers
 * it. It does not. A wine can be in the tenant's catalogue and still be one the
 * model invented for this answer — the subtle case, and the one a naive
 * ownership check admits. One invariant, in one place.
 *
 * **Nothing here reads a database, an HTTP request or a clock.** It is a pure
 * function over a set, which is what makes it exhaustively testable — and this
 * is the function in the plan that most has to be right.
 */

export interface AllowlistResult {
  /** What a visitor may be shown, in the order the model ranked it. */
  readonly items: readonly Recommendation[];
  /**
   * What was refused, kept rather than discarded.
   *
   * **A non-empty `dropped` is a model-quality signal worth alerting on**: a
   * model that names wines outside its candidates is either being injected or
   * is not following the prompt, and both are things to find out about from a
   * metric rather than from a merchant. P2-26 asserts on it, and the chat route
   * logs it.
   */
  readonly dropped: readonly Recommendation[];
}

/**
 * Keep only the recommendations naming a wine from this request's candidates.
 *
 * **A repeat is dropped as well**, after the first. A model naming one wine
 * twice is not a security failure — the id is in the set both times — but two
 * identical cards is a visible defect, and this is the one place the list is
 * examined before a visitor sees it. It lands in `dropped` because it is the
 * same kind of signal: the model did not do what it was asked.
 */
const partition = (
  recommendations: readonly Recommendation[],
  candidateIds: ReadonlySet<string>,
): AllowlistResult => {
  const items: Recommendation[] = [];
  const dropped: Recommendation[] = [];
  const seen = new Set<string>();

  for (const recommendation of recommendations) {
    if (candidateIds.has(recommendation.productId) && !seen.has(recommendation.productId)) {
      seen.add(recommendation.productId);
      items.push(recommendation);
    } else {
      dropped.push(recommendation);
    }
  }

  return { items, dropped };
};

export const allowlistRecommendations = (
  out: PairingOutput,
  candidateIds: ReadonlySet<string>,
): AllowlistResult => partition(out.recommendations, candidateIds);

/**
 * The allowlist, applied to a provider's stream (P2-26).
 *
 * **One place, not three.** Every adapter in `packages/llm` yields a
 * `recommendations` chunk straight from what the model returned, because an
 * adapter's job is to translate a vendor's format and nothing else. If each of
 * them applied the allowlist there would be three copies of the boundary and
 * the next adapter would make four — and the one that forgot would be the one
 * nobody noticed, because its output looks identical until a model misbehaves.
 *
 * **Text and errors pass through untouched.** The reply is prose this cannot
 * check (P2-23 caps it, P2-27 checks it for leaked instructions); an error is
 * the caller's to handle.
 *
 * **An answer whose every card was dropped still yields an empty
 * `recommendations` chunk**, rather than none. "The model named nothing you may
 * see" and "the model is still writing" are different states, and a consumer
 * waiting for a chunk that never comes would show a spinner for the second when
 * it is in the first.
 */
export const allowlisted = async function* (
  chunks: AsyncIterable<PairingChunk>,
  candidateIds: ReadonlySet<string>,
  onDropped: (dropped: readonly Recommendation[]) => void = () => undefined,
): AsyncIterable<PairingChunk> {
  for await (const chunk of chunks) {
    if (chunk.type !== 'recommendations') {
      yield chunk;
      continue;
    }

    const { items, dropped } = partition(chunk.items, candidateIds);

    if (dropped.length > 0) onDropped(dropped);

    yield { type: 'recommendations', items };
  }
};
