import { InvalidRequestError } from '../errors.js';

/**
 * The days an analytics panel covers (P6-02).
 *
 * **Whole days, in UTC, both ends included** — the day a seller picks is the
 * day they mean, and UTC because the usage ledger and its nightly rollup
 * (P5-13) count days in UTC: two panels that disagreed about where a day ends
 * would disagree about a number on the same screen.
 *
 * **Bounded at a year.** The panels read raw events (P6-02's launch decision),
 * and a range is work proportional to its length.
 */

/** What a panel shows when nobody has picked a range: the last thirty days, today included. */
export const DEFAULT_RANGE_DAYS = 30;

/** The longest range a panel reads. A leap year, so "the last year" always fits. */
export const MAX_RANGE_DAYS = 366;

export interface AnalyticsRange {
  /** `YYYY-MM-DD`, UTC, the first day included. */
  readonly from: string;
  /** `YYYY-MM-DD`, UTC, the last day included. */
  readonly to: string;
  /** The first instant of `from`. */
  readonly start: Date;
  /** The first instant *after* `to`: the range is `[start, end)`. */
  readonly end: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const RANGE_EXPECTED =
  `Give from and to as YYYY-MM-DD days, from no later than to, at most ${String(MAX_RANGE_DAYS)} ` +
  'days apart.';

const dayOf = (instant: Date): string => instant.toISOString().slice(0, 10);

/** The first instant of a `YYYY-MM-DD` day, or `undefined` for anything that is not one. */
const startOf = (day: string): Date | undefined => {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(day)) return undefined;

  const start = new Date(`${day}T00:00:00.000Z`);

  /* `Date` rolls 2026-02-30 over to March; a day that does not round-trip is not one. */
  return Number.isNaN(start.getTime()) || dayOf(start) !== day ? undefined : start;
};

/**
 * The range a request asked for, or the default.
 *
 * Either end may be left out: `to` defaults to today, `from` to thirty days
 * ending at `to`. Anything else that is not a range is refused with
 * `RANGE_EXPECTED`, which names what is wanted.
 */
export const analyticsRange = (
  asked: { readonly from?: string | undefined; readonly to?: string | undefined },
  now: Date = new Date(),
): AnalyticsRange => {
  const last = asked.to === undefined ? startOf(dayOf(now)) : startOf(asked.to);

  if (last === undefined) throw new InvalidRequestError(RANGE_EXPECTED);

  const first =
    asked.from === undefined
      ? new Date(last.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS)
      : startOf(asked.from);

  if (first === undefined || first > last) throw new InvalidRequestError(RANGE_EXPECTED);

  const days = (last.getTime() - first.getTime()) / DAY_MS + 1;

  if (days > MAX_RANGE_DAYS) throw new InvalidRequestError(RANGE_EXPECTED);

  return {
    from: dayOf(first),
    to: dayOf(last),
    start: first,
    end: new Date(last.getTime() + DAY_MS),
  };
};
