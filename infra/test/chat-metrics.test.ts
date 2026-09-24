import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CHAT_ESCALATIONS_METRIC as API_ESCALATIONS,
  CHAT_METRIC_NAMESPACE as API_NAMESPACE,
  CHAT_TURNS_METRIC as API_TURNS,
} from '../../apps/api/src/chat-metrics.js';
import { describe, expect, it } from 'vitest';

import {
  CHAT_ESCALATIONS_METRIC,
  CHAT_METRIC_NAMESPACE,
  CHAT_TURNS_METRIC,
  escalationRateExpression,
  ESCALATION_MIN_TURNS,
  ESCALATION_PERIOD_SECONDS,
  ESCALATION_RATE_THRESHOLD,
} from '../chat-metrics.js';

/**
 * The escalation-rate alarm (P2-28), and the contract it rests on.
 *
 * **Two halves that cannot import each other.** The chat route writes the metric
 * line; `infra/` builds the alarm that reads it. `infra/` is not a package and
 * must never be in the application's module graph, since it constructs AWS
 * resources at import — so the names are declared twice and held together here.
 *
 * A mismatch would be an alarm watching a metric nobody emits: no error, no
 * datapoints, and `notBreaching` turning that silence into a green alarm. The
 * cost control would look healthy for exactly as long as nobody checked.
 */

describe('the names both halves use', () => {
  it('agree, because an alarm on a metric nobody emits is a green alarm forever', () => {
    expect(API_NAMESPACE).toBe(CHAT_METRIC_NAMESPACE);
    expect(API_TURNS).toBe(CHAT_TURNS_METRIC);
    expect(API_ESCALATIONS).toBe(CHAT_ESCALATIONS_METRIC);
  });
});

describe('the rate it alarms on', () => {
  it('is a few percent, as §4.5 asks', () => {
    // Below it the cheap tier is doing its job; above it the cheap tier is
    // failing, and the answer is §Open Decision 1 rather than a bigger number.
    expect(ESCALATION_RATE_THRESHOLD).toBeGreaterThan(0);
    expect(ESCALATION_RATE_THRESHOLD).toBeLessThanOrEqual(0.15);
  });

  it('is a rate, not a count, which is why this waited for a denominator', () => {
    /*
     * P2-28 could emit every escalation the day it was written. A count of
     * those alarms on a busy Saturday — the opposite of what the row wants.
     * Turns arrived with P2-29 and P2-31.
     */
    expect(escalationRateExpression()).toContain('/');
  });

  it('returns nothing at all under a floor of turns', () => {
    // Two turns in an hour, one escalated, is fifty percent and says nothing.
    // An alarm that fired on it is one people learn to ignore.
    expect(escalationRateExpression()).toContain(`>= ${String(ESCALATION_MIN_TURNS)}`);
    expect(ESCALATION_MIN_TURNS).toBeGreaterThan(1);
  });

  it('names the ids the alarm gives its two metrics', () => {
    expect(escalationRateExpression('turns', 'esc')).toBe(
      `IF(turns >= ${String(ESCALATION_MIN_TURNS)}, esc / turns)`,
    );
  });

  it('measures over long enough for a rate to mean something', () => {
    expect(ESCALATION_PERIOD_SECONDS).toBeGreaterThanOrEqual(900);
  });
});

describe('api.ts', () => {
  /*
   * `api.ts` builds AWS resources at import and cannot be loaded here, so the
   * wiring is read from its source — the same blunt instrument `cdn.ts` gets,
   * and the only thing that fails if somebody inlines a name or drops the
   * missing-data treatment.
   */
  const source = readFileSync(fileURLToPath(new URL('../api.ts', import.meta.url)), 'utf8');

  it('builds the alarm from the constants rather than from literals', () => {
    expect(source).toContain('expression: escalationRateExpression()');
    expect(source).toContain('threshold: ESCALATION_RATE_THRESHOLD');
    expect(source).toContain('metricName: CHAT_TURNS_METRIC');
    expect(source).toContain('metricName: CHAT_ESCALATIONS_METRIC');
  });

  it('treats missing data as quiet, since the expression withholds it on purpose', () => {
    expect(source).toMatch(/ChatEscalationRate[\S\s]{0,1200}notBreaching/);
  });
});
