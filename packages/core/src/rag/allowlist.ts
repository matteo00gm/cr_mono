import type { Recommendation } from './llm-provider.js';
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
export const allowlistRecommendations = (
  out: PairingOutput,
  candidateIds: ReadonlySet<string>,
): AllowlistResult => {
  const items: Recommendation[] = [];
  const dropped: Recommendation[] = [];
  const seen = new Set<string>();

  for (const recommendation of out.recommendations) {
    if (candidateIds.has(recommendation.productId) && !seen.has(recommendation.productId)) {
      seen.add(recommendation.productId);
      items.push(recommendation);
    } else {
      dropped.push(recommendation);
    }
  }

  return { items, dropped };
};
