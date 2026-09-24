/**
 * The chat turn's metrics, and the rate P2-28 wants alarming on.
 *
 * Apart from `api.ts` for the reason `sweep-config.ts` is apart from
 * `schedules.ts`: that module constructs SST resources at import time and
 * cannot be loaded outside a deploy, so nothing could check what it was built
 * from.
 *
 * **This closes the open item P2-28 recorded.** That row asks for an alarm when
 * the escalation *rate* exceeds a few percent, and a rate needs a denominator —
 * turns — which did not exist until P2-29 streamed them and P2-31 counted them.
 * An alarm on an absolute count would have fired on traffic, which is the
 * opposite of what the row wants: a busy Saturday is not the cheap tier failing.
 */

/** What `apps/api/src/surfaces/widget.ts` writes into its turn line, and the alarm reads. A contract. */
export const CHAT_METRIC_NAMESPACE = 'Catalogorosso/Chat';

/** Every answered turn, escalated or not. The denominator. */
export const CHAT_TURNS_METRIC = 'Turns';

/** The turns P2-28 sent to the stronger tier. The numerator. */
export const CHAT_ESCALATIONS_METRIC = 'Escalations';

/**
 * The share of turns that may escalate before it is worth a person's attention.
 *
 * **§4.5 says "a few percent", and ten is where a few stops.** Below it the
 * cheap tier is doing its job and the cascade is working as designed; above it
 * the cheap tier is failing, and the answer is to revisit §Open Decision 1
 * rather than to raise this number until the alarm stops.
 */
export const ESCALATION_RATE_THRESHOLD = 0.1;

/**
 * An hour.
 *
 * Long enough that a handful of turns cannot produce a rate at all — five
 * escalations out of eight is a statistic about nothing — and short enough that
 * a genuine shift is seen the same day.
 */
export const ESCALATION_PERIOD_SECONDS = 3600;

/**
 * How many turns an hour must carry before the rate means anything.
 *
 * **The alarm is on the rate, and a rate over a tiny denominator is noise.**
 * Two turns in an hour, one escalated, is fifty percent — and says nothing.
 * The expression below returns nothing at all under this floor, and
 * `treatMissingData: notBreaching` is what makes "nothing" mean "quiet".
 */
export const ESCALATION_MIN_TURNS = 20;

/**
 * The metric maths, as CloudWatch spells it.
 *
 * Built here rather than inline so it can be read in a test: an expression is
 * a string CloudWatch validates at deploy time and nothing validates before
 * then, so what a test can check is that the pieces it names are the pieces
 * that are emitted.
 */
export const escalationRateExpression = (
  turns = 't',
  escalations = 'e',
  minimum = ESCALATION_MIN_TURNS,
): string => `IF(${turns} >= ${String(minimum)}, ${escalations} / ${turns})`;
