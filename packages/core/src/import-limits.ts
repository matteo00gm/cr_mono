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

/**
 * Wines per import. Over it the whole import is refused, never truncated.
 *
 * **The largest catalogue any plan allows**, E-commerce's 2,500 SKUs (P5-01),
 * rather than the 10,000 it was (review fix). An import cannot usefully be larger
 * than the catalogue it lands in, and at 2,500 the other limits stop binding for
 * a real one: it fits the request cap below with room to spare, and its batches
 * take about three seconds of `IMPORT_TIME_BUDGET_MS`.
 */
export const MAX_IMPORT_ROWS = 2_500;

/**
 * The size of a file the dashboard will read.
 *
 * A full catalogue with long tasting notes is a few megabytes of CSV; ten is
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
 * **For a real catalogue it no longer binds** — measured, not guessed: ten
 * thousand fully described wines serialise to 5.7 MB of JSON with no tasting
 * notes and 9.5 MB with 400-character ones, so the 2,500 the row cap allows come
 * to about 1.4 and 2.4 MB. It still refuses an import whose notes run to
 * kilobytes a wine, and that refusal tells the seller to split the file.
 */
export const MAX_IMPORT_BODY_BYTES = 5 * 1024 * 1024;

/**
 * The API function's timeout, in seconds — the `timeout` in `infra/api.ts`.
 *
 * Restated rather than imported, because nothing under `infra/` can be imported
 * outside a deploy. `apps/api/test/import-time-budget.test.ts` reads the line
 * out of `infra/api.ts` and fails when the two disagree, so the import below
 * cannot go on budgeting against a timeout that has moved.
 */
export const API_TIMEOUT_SECONDS = 10;

/**
 * How long one import request may spend applying batches (review fix, P1-25).
 *
 * **The function is killed at ten seconds, and a large import did not fit.**
 * Ten thousand changed wines took 12.2 s against local Postgres, the fastest a
 * database will ever be, so in production the Lambda was cut off part-way: the
 * batches before the kill committed, and the seller got a gateway error and no
 * report of how far it got.
 *
 * So the import stops *between* batches once another would not fit, stores
 * where it stopped like any other stopped import, and the dashboard sends the
 * rest as a new attempt. Six seconds leaves the rest of the ten for parsing and
 * validating up to 5 MB of rows before the budget starts, one batch that runs
 * slower than any before it, and storing the result.
 */
export const IMPORT_TIME_BUDGET_MS = 6_000;
