import { describe, expect, it } from 'vitest';

import { catalogues } from '../src/i18n/index.js';
import {
  acceptsQuestions,
  isRetryable,
  noticeKeyOf,
  stateFor,
  type WidgetState,
} from '../src/states.js';

/**
 * The five states (P3-07, §1.3).
 *
 * **Every state is listed once, here**, and every case below iterates that
 * list. A sixth state added to the union is a typecheck failure in `states.ts`
 * and a missing entry here — which is the point of driving a UI from a
 * discriminated union rather than from a handful of booleans.
 */

const ALL: readonly WidgetState[] = [
  { k: 'active' },
  { k: 'disabled' },
  { k: 'quota' },
  { k: 'rateLimited', retryAfter: 30 },
  { k: 'error', cause: 'provider' },
  { k: 'error', cause: 'network' },
];

describe('which state the widget is in', () => {
  it('is active when the winery is serving and nothing has gone wrong', () => {
    expect(stateFor('ACTIVE', undefined)).toEqual({ k: 'active' });
  });

  it('reports a failure the conversation recorded', () => {
    expect(stateFor('ACTIVE', { k: 'quota' })).toEqual({ k: 'quota' });
  });

  it('lets a switched-off winery outrank everything', () => {
    /*
     * The loader normally stops long before this (P3-03). A seller can lapse
     * mid-session, though, and then the API starts refusing a page that already
     * has the chat open — the visitor is told the shop is not serving, not that
     * we are broken.
     */
    expect(stateFor('DISABLED', { k: 'error', cause: 'provider' })).toEqual({ k: 'disabled' });
  });
});

describe('what each state says', () => {
  it('gives every state but active a notice', () => {
    for (const state of ALL) {
      expect(noticeKeyOf(state), state.k).toStrictEqual(
        state.k === 'active' ? undefined : expect.any(String),
      );
    }
  });

  it('has a sentence in both catalogues for every notice', () => {
    for (const state of ALL) {
      const key = noticeKeyOf(state);

      if (key === undefined) continue;

      expect(catalogues.it[key], `it.${key}`).toBeTruthy();
      expect(catalogues.en[key], `en.${key}`).toBeTruthy();
    }
  });

  it('says nothing at all in the active state, because the chat is the notice', () => {
    expect(noticeKeyOf({ k: 'active' })).toBeUndefined();
  });

  it('tells the two kinds of failure apart', () => {
    expect(noticeKeyOf({ k: 'error', cause: 'network' })).toBe('errorNetwork');
    expect(noticeKeyOf({ k: 'error', cause: 'provider' })).toBe('errorProvider');
  });

  it('names no plan, price or count in any state, in either language', () => {
    /* §1.3, asserted against what a visitor would actually be shown. */
    const forbidden = /piano|plan|abbonament|subscription|€|\$|messagg|message/iu;

    for (const state of ALL) {
      const key = noticeKeyOf(state);

      if (key === undefined) continue;

      expect(catalogues.it[key], `it.${key}`).not.toMatch(forbidden);
      expect(catalogues.en[key], `en.${key}`).not.toMatch(forbidden);
    }
  });

  it('shows no number anywhere except the countdown §1.3 asks for', () => {
    for (const state of ALL) {
      const key = noticeKeyOf(state);

      if (key === undefined || state.k === 'rateLimited') continue;

      expect(catalogues.it[key], `it.${key}`).not.toMatch(/\d/u);
      expect(catalogues.en[key], `en.${key}`).not.toMatch(/\d/u);
    }
  });
});

describe('what a visitor can do next', () => {
  it('offers a retry for a shop that is busy and a connection that dropped', () => {
    expect(isRetryable({ k: 'error', cause: 'provider' })).toBe(true);
    expect(isRetryable({ k: 'error', cause: 'network' })).toBe(true);
  });

  it('offers a retry for a burst limit, which the countdown gates', () => {
    expect(isRetryable({ k: 'rateLimited', retryAfter: 30 })).toBe(true);
  });

  it('offers no retry for a spent month or a switched-off winery', () => {
    /* A button that says otherwise wastes a visitor's time to tell them the
     * same thing again. */
    expect(isRetryable({ k: 'quota' })).toBe(false);
    expect(isRetryable({ k: 'disabled' })).toBe(false);
  });

  it('takes questions while active, and after a failure worth retrying', () => {
    expect(acceptsQuestions({ k: 'active' })).toBe(true);
    expect(acceptsQuestions({ k: 'error', cause: 'network' })).toBe(true);
  });

  it('takes no questions once the month is spent or the widget is off', () => {
    // §1.3: "input disabled".
    expect(acceptsQuestions({ k: 'quota' })).toBe(false);
    expect(acceptsQuestions({ k: 'disabled' })).toBe(false);
  });

  it('takes no questions while a burst limit is being waited out', () => {
    expect(acceptsQuestions({ k: 'rateLimited', retryAfter: 30 })).toBe(false);
  });
});
