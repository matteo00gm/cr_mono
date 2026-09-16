/**
 * The candidate cap (P2-22, §4.4).
 *
 * **Eight is three controls wearing one number.** It bounds the prompt, which
 * is cost; it bounds the time a model spends reading it, which is latency; and
 * it bounds the prompt-injection surface, because every candidate is untrusted
 * seller text and fewer of them is less of it (P2-23 delimits what does get
 * through, and P2-25 is what stops the model naming anything outside the set).
 *
 * **The count before the cut is the part that cannot be recovered afterwards.**
 * §2.4's `ZERO_RESULTS` panel exists to tell "nothing matched" from "matched,
 * but weakly", and after a slice both look like eight rows or none.
 */

/** How many wines reach the prompt (§4.4). A parameter, so P1-46's eval can sweep it. */
export const MAX_CANDIDATES = 8;

export class InvalidCandidateCapError extends Error {
  constructor(cap: number) {
    super(
      `A candidate cap of ${String(cap)} is not a count. A sweep that reaches here with a ` +
        'negative one would take all but the last candidate rather than refusing, which ' +
        'is a silently different experiment (P2-22).',
    );
    this.name = 'InvalidCandidateCapError';
  }
}

export interface CappedCandidates<T> {
  /** What reaches the prompt, in the order fusion produced. */
  readonly candidates: readonly T[];
  /**
   * How many survived filtering, before the cut.
   *
   * Never the length of `candidates`: the two are equal until they matter.
   */
  readonly consideredCount: number;
}

/**
 * Take the best `cap` candidates, and report how many there were.
 *
 * **It does not re-rank.** The order is fusion's, narrowed by P2-21's filter,
 * and a cap that sorted would be a third ranking nobody asked for.
 */
export const capCandidates = <T>(
  candidates: readonly T[],
  cap: number = MAX_CANDIDATES,
): CappedCandidates<T> => {
  if (!Number.isInteger(cap) || cap < 0) throw new InvalidCandidateCapError(cap);

  return { candidates: candidates.slice(0, cap), consideredCount: candidates.length };
};
