/**
 * Compares Postgres timestamps at the precision Postgres actually keeps.
 *
 * Two traps sit behind this helper, and a test can fall into either silently.
 *
 * `db.execute` returns `timestamptz` as a **string**, not a Date — the raw
 * path hands back what the driver read off the wire. `Number()` on one is
 * `NaN`, and `NaN > NaN` is false, so an assertion written that way fails no
 * matter what the trigger did, while reading like a real comparison. That is
 * how four `updated_at` tests failed the first time they were ever run.
 *
 * And `Date.parse` truncates to milliseconds while Postgres stores
 * microseconds. An insert followed immediately by an update — routine in these
 * suites — can land inside the same millisecond, so a correct trigger would
 * still fail intermittently.
 *
 * So: take the millisecond value from `Date.parse`, which handles the offset,
 * and add the sub-millisecond remainder back from the fractional digits.
 */
export const timestampMicros = (value: unknown): bigint => {
  const raw = String(value);
  const milliseconds = Date.parse(raw);

  if (Number.isNaN(milliseconds)) {
    throw new Error(`not a Postgres timestamp: ${raw}`);
  }

  const fraction = /\.(\d{1,6})/.exec(raw)?.[1] ?? '';
  const subMillisecond = Number(fraction.padEnd(6, '0')) % 1000;

  return BigInt(milliseconds) * 1000n + BigInt(subMillisecond);
};
