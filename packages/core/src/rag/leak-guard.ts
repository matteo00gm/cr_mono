import type { PairingChunk } from './llm-provider.js';
import { leaksInstructions, PROMPT_MARKER } from './prompt.js';

/**
 * Nothing that quotes the instructions reaches a visitor (P2-32, §3.7).
 *
 * **`trustedPairing` already refuses a parsed reply that quotes them** (P1-42),
 * and that check runs after the model has finished. The adapters stream text
 * deltas *before* it — so a model that echoes its instructions as prose reaches
 * a visitor, and no delta can be un-sent. This is the half of that boundary
 * that works on a stream, and it is the one P2-27 recorded as open.
 *
 * **It holds back whatever could still become one of the things it looks for.**
 * Checking each delta on its own is useless: a marker split as
 * `cr-sommelier-` and `istruzioni-v1` matches neither half. A *fixed* holdback
 * is not enough either, and that was this file's first design — with the check
 * running on everything received so far, the marker's opening characters are
 * released before its closing ones arrive, and the guard stops after leaking
 * twenty-two of its twenty-six characters. The mutation run found it.
 *
 * So the rule is: release a character only once no pattern could still be
 * growing through it. A tail that is a prefix of something we refuse is held
 * until the next delta settles what it was.
 *
 * **On a leak it stops, and does not error.** Nothing recognisable was
 * released, so the visitor has a reply that stops early rather than one quoting
 * our prompt. Erroring would replace a partial answer with no answer, and the
 * partial one is the better outcome — the caller is told, and alerts on it.
 */

/**
 * The literals a released character could still be growing into.
 *
 * The marker, and the delimiters `leaksInstructions` matches with a regular
 * expression — written here as the literal openings that regex can match, since
 * what this needs is "could this tail still become one", which a pattern cannot
 * be asked and a prefix can.
 */
const PATTERNS: readonly string[] = [
  PROMPT_MARKER,
  '<candidato',
  '</candidato',
  '<candidati',
  '</candidati',
  '<messaggio_visitatore',
  '</messaggio_visitatore',
];

/** The longest thing a tail could be growing into. Exported so a test can pin the bound. */
export const LONGEST_PATTERN = Math.max(...PATTERNS.map((pattern) => pattern.length));

/**
 * How many characters at the end of `text` could still become a pattern.
 *
 * Longest first, so `</candidat` is held as the ten characters it is rather
 * than the one `<` a shorter match would settle for.
 */
const unresolvedTail = (text: string): number => {
  for (let held = Math.min(text.length, LONGEST_PATTERN); held > 0; held -= 1) {
    const tail = text.slice(text.length - held);

    if (PATTERNS.some((pattern) => pattern.startsWith(tail))) return held;
  }

  return 0;
};

/**
 * Passes chunks through, refusing to release text that quotes the instructions.
 *
 * Recommendations and errors are not text and go straight through: an id is
 * checked by P2-25, and an error code is ours.
 */
export const withoutLeakedInstructions = async function* (
  chunks: AsyncIterable<PairingChunk>,
  onLeak: () => void = () => undefined,
): AsyncIterable<PairingChunk> {
  let pending = '';
  let leaked = false;

  for await (const chunk of chunks) {
    if (chunk.type !== 'text') {
      yield chunk;
      continue;
    }

    if (leaked) continue;

    pending += chunk.delta;

    const ready = pending.slice(0, pending.length - unresolvedTail(pending));

    if (ready === '') continue;

    /*
     * **Checked on its own, and that is a consequence of the holdback rather
     * than an oversight.** A release boundary can never fall inside a pattern,
     * because a tail that could still become one is held — so any occurrence
     * lies entirely within one release, and accumulating the text released
     * before it would be a concatenation that could never change the answer.
     * Remove the holdback and this stops being true.
     */
    if (leaksInstructions(ready)) {
      leaked = true;
      onLeak();
      continue;
    }

    pending = pending.slice(ready.length);

    yield { type: 'text', delta: ready };
  }

  if (leaked || pending === '') return;

  /*
   * The tail, checked whole. What is held here is a string that *could* have
   * become a pattern and did not — a reply ending in `<` is the ordinary case —
   * so it is checked once more and released.
   */
  if (leaksInstructions(pending)) {
    onLeak();
    return;
  }

  yield { type: 'text', delta: pending };
};
