/**
 * How much one import may carry (§2.2a, P1-27).
 *
 * **One set of numbers, read by both sides.** The dashboard refuses before it
 * parses a file or sends a request, so a seller hears about a cap in a second
 * rather than after an upload; the API refuses again, because a cap enforced
 * only in a browser is a suggestion to anybody with `curl`. Two copies of the
 * same number drift the day one of them is changed.
 *
 * A file that imports nothing, so the dashboard can take it through a subpath
 * without pulling the `core` barrel into a browser (P1-13's rule).
 */

/** Wines per import. Over it the whole import is refused, never truncated. */
export const MAX_IMPORT_ROWS = 10_000;

/**
 * The size of a file the dashboard will read.
 *
 * Ten thousand wines with long tasting notes are a few megabytes of CSV; ten is
 * room for that, and refuses a file that could only be something else — a
 * photo, an export of a whole shop — before a tab hangs parsing it.
 */
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

/**
 * The size of one import request, as the JSON the API receives.
 *
 * **Below the platform's ceiling, so the refusal is ours.** The API is a Lambda
 * behind a Function URL, which refuses a request over 6 MB before any of our
 * code runs, with an answer that names no limit and suggests nothing. Five
 * leaves room for the rest of the request and makes the message a seller reads
 * the one that says what to do.
 *
 * **For a real catalogue it binds before the row cap does** — measured, not
 * guessed: ten thousand fully described wines serialise to 5.7 MB of JSON with
 * no tasting notes and 9.5 MB with 400-character ones. How the dashboard sends
 * an import that large is P1-23's decision, recorded as open in the plan.
 */
export const MAX_IMPORT_BODY_BYTES = 5 * 1024 * 1024;
