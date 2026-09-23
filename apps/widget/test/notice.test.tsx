import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Notice } from '../src/components/Notice.js';
import { en } from '../src/i18n/en.js';
import { it as italian } from '../src/i18n/it.js';
import { format, type Messages } from '../src/i18n/index.js';
import { MessagesContext } from '../src/i18n/useT.js';
import type { WidgetState } from '../src/states.js';

/**
 * What a visitor is told (P3-07, §1.3).
 *
 * **Each state renders its own notice, and the countdown is the only moving
 * part.** The row asks for three things: every state says something, a 429 with
 * `Retry-After` counts down, and no state leaks a plan or a count — the last
 * one asserted against what is on screen rather than against the catalogue,
 * because a rendering is what a shopper sees.
 */

afterEach(cleanup);

const show = (
  state: WidgetState,
  onRetry: () => void = () => undefined,
  messages: Messages = italian,
) =>
  render(
    <MessagesContext.Provider value={messages}>
      <Notice state={state} onRetry={onRetry} />
    </MessagesContext.Provider>,
  );

const text = (): string => screen.getByRole('status').textContent ?? '';

/**
 * Advances the clock and lets Preact catch up.
 *
 * `advanceTimersByTime` runs the interval callbacks, which only *schedule* a
 * rerender — Preact batches on a microtask. Without `act` the assertion reads
 * the DOM one tick before the thing it is asserting about.
 */
const tick = (ms: number): void => {
  void act(() => {
    vi.advanceTimersByTime(ms);
  });
};
const retryButton = (): HTMLButtonElement | null =>
  screen.queryByRole<HTMLButtonElement>('button', { name: italian.retry });

describe('each state says its piece', () => {
  it('says nothing at all when the chat is working', () => {
    show({ k: 'active' });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('tells a visitor a switched-off winery is not serving', () => {
    show({ k: 'disabled' });

    expect(text()).toContain(italian.disabled);
    expect(retryButton()).toBeNull();
  });

  it('tells a visitor a spent month in a way that does not invite a retry', () => {
    show({ k: 'quota' });

    expect(text()).toContain(italian.quota);
    expect(retryButton()).toBeNull();
  });

  it('tells the shop being busy apart from the connection dropping', () => {
    show({ k: 'error', cause: 'provider' });
    expect(text()).toContain(italian.errorProvider);

    cleanup();

    show({ k: 'error', cause: 'network' });
    expect(text()).toContain(italian.errorNetwork);
  });

  it('offers a retry for a failure a retry can fix', () => {
    const onRetry = vi.fn();

    show({ k: 'error', cause: 'network' }, onRetry);
    fireEvent.click(screen.getByRole('button', { name: italian.retry }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('announces itself politely rather than as an alert', () => {
    // A notice is information, not an emergency; `role="status"` is polite.
    show({ k: 'error', cause: 'provider' });

    expect(screen.getByRole('status').getAttribute('role')).toBe('status');
  });
});

describe('waiting out a burst limit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts down from Retry-After', () => {
    show({ k: 'rateLimited', retryAfter: 3 });

    expect(text()).toContain(format(italian.rateLimited, { seconds: 3 }));

    tick(1000);
    expect(text()).toContain(format(italian.rateLimited, { seconds: 2 }));

    tick(1000);
    expect(text()).toContain(format(italian.rateLimited, { seconds: 1 }));
  });

  it('says when the wait is over', () => {
    show({ k: 'rateLimited', retryAfter: 2 });

    tick(2000);

    expect(text()).toContain(italian.rateLimitedReady);
  });

  it('does not count past zero', () => {
    /* A countdown that keeps going is a negative number on a seller's site. */
    show({ k: 'rateLimited', retryAfter: 1 });

    tick(10_000);

    expect(text()).toContain(italian.rateLimitedReady);
    expect(text()).not.toMatch(/-\d/u);
  });

  it('will not let a visitor retry before the wait is out', () => {
    // Retrying early is another 429, which resets the wait.
    show({ k: 'rateLimited', retryAfter: 5 });

    expect(retryButton()?.disabled).toBe(true);

    tick(5000);

    expect(retryButton()?.disabled).toBe(false);
  });

  it('restarts when a second refusal arrives with a longer wait', () => {
    const view = show({ k: 'rateLimited', retryAfter: 2 });

    tick(1000);

    view.rerender(
      <MessagesContext.Provider value={italian}>
        <Notice state={{ k: 'rateLimited', retryAfter: 9 }} onRetry={() => undefined} />
      </MessagesContext.Provider>,
    );

    expect(text()).toContain(format(italian.rateLimited, { seconds: 9 }));
  });

  it('stops ticking once the wait is over, not only on unmount', () => {
    /*
     * A timer that keeps firing after the countdown finishes is a wakeup a
     * second, forever, on somebody else's storefront — and it is invisible,
     * because the notice reads the same at zero as it does at minus four
     * hundred. Found by mutation, which is the only thing that could have.
     */
    show({ k: 'rateLimited', retryAfter: 2 });

    tick(2000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops ticking when the panel goes away', () => {
    /*
     * A timer left running in a closed panel is a wakeup a second, forever, on
     * a page that is not ours.
     */
    show({ k: 'rateLimited', retryAfter: 60 }).unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('what a shopper is never told', () => {
  const STATES: readonly WidgetState[] = [
    { k: 'disabled' },
    { k: 'quota' },
    { k: 'rateLimited', retryAfter: 30 },
    { k: 'error', cause: 'provider' },
    { k: 'error', cause: 'network' },
  ];

  it('names no plan and no message count, in either language', () => {
    for (const messages of [italian, en]) {
      for (const state of STATES) {
        show(state, () => undefined, messages);

        expect(text(), state.k).not.toMatch(/piano|plan|abbonament|subscription|€|\$|messagg/iu);

        cleanup();
      }
    }
  });

  it('shows no number except the countdown', () => {
    for (const state of STATES) {
      show(state);

      if (state.k !== 'rateLimited') expect(text(), state.k).not.toMatch(/\d/u);

      cleanup();
    }
  });
});

describe('a notice rendered outside the provider', () => {
  it('speaks the source language rather than throwing', () => {
    /*
     * Rendering outside the provider is a wiring mistake, and a widget that
     * shows the shop's own language on a seller's storefront is a better
     * failure than one that renders an exception into their page.
     */
    render(<Notice state={{ k: 'quota' }} onRetry={() => undefined} />);

    expect(text()).toContain(italian.quota);
  });
});

describe('a value that arrives as markup', () => {
  it('renders as text, never as an element', () => {
    /*
     * `format` deliberately does not escape — the caller renders a text node and
     * Preact escapes there. This is the assertion that the caller actually does.
     */
    show({ k: 'rateLimited', retryAfter: 5 }, () => undefined, {
      ...italian,
      rateLimited: '{seconds}<img src=x onerror=alert(1)>',
    });

    expect(screen.getByRole('status').querySelector('img')).toBeNull();
    expect(text()).toContain('<img src=x onerror=alert(1)>');
  });
});
