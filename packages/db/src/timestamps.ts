/**
 * Timestamps out of a hand-written statement.
 *
 * **A raw `execute` returns `timestamptz` as a string, not a `Date`.** Drizzle
 * parses column types for a typed select and does nothing of the kind for a
 * statement written by hand — so the row cast says `Date`, TypeScript believes
 * it, and the value is a string at runtime.
 *
 * **Nothing fails loudly, which is why this survived.** `rate-limit.ts` found
 * it the hard way in CI and wrote down the reason it stayed hidden: the test
 * double and the code were written from the same assumption, so they agreed
 * with each other and not with Postgres. Every site that repeats that pattern
 * repeats that blind spot, and a mocked driver cannot see any of them.
 *
 * What it costs downstream depends on what the caller does next. In the domains
 * port it was a thrown `TypeError` on `.toISOString()`. On the members screen
 * it is quieter and worse: the string reaches the wire as
 * `2026-10-02 01:01:04.326752+00`, the dashboard's client parses every response
 * against `z.iso.datetime()`, and that is not ISO-8601 — a space instead of a
 * `T`, `+00` instead of `+00:00` — so the parse throws and the screen does not
 * load at all.
 *
 * Postgres's own format is one `new Date()` reads correctly. Normalising it to
 * ISO first does not help and makes it worse: a `T` in front of a `+00` offset
 * is exactly what an ISO parser rejects.
 */

/** The column's type as declared, and as the driver may actually deliver it. */
export type SqlTimestamp = string | Date;

export const asDate = (value: SqlTimestamp): Date =>
  value instanceof Date ? value : new Date(value);

/** The same, for a nullable column. `new Date(null)` is 1970, which is not null. */
export const asDateOrNull = (value: SqlTimestamp | null): Date | null =>
  value === null ? null : asDate(value);
