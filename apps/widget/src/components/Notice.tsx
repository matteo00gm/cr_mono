import { useEffect, useState } from 'preact/hooks';

import { useT } from '../i18n/useT.js';
import { isRetryable, noticeKeyOf, type WidgetState } from '../states.js';

/**
 * What a visitor is told when the chat is not simply working (P3-07, §1.3).
 *
 * **One component for all five states**, driven by the union. A notice per
 * state would be five places to forget a `role`, and the sixth state somebody
 * adds would render nothing at all with every test still passing.
 *
 * **Never a plan, a price or a count.** The only number that reaches a shopper
 * is the countdown §1.3 asks for, and that one is seconds.
 */

export interface NoticeProps {
  readonly state: WidgetState;
  readonly onRetry: () => void;
}

/**
 * Seconds left, ticking down to zero.
 *
 * **Restarts whenever the wait does**, because a second 429 arriving while the
 * first countdown is running must show the new wait rather than finish the old
 * one.
 *
 * **It stops at zero, and not only on unmount.** A timer that keeps firing once
 * the wait is over is a wakeup a second, forever, on somebody else's storefront
 * — and it is invisible, because the notice reads the same at zero as it does
 * at minus four hundred. Mutation testing is what found that: the version that
 * counted past zero rendered identically and nothing failed.
 */
export const useCountdown = (seconds: number): number => {
  const [left, setLeft] = useState(seconds);

  useEffect(() => {
    setLeft(seconds);

    if (seconds <= 0) return undefined;

    /* Counted in the closure rather than read back from state, so the interval
     * can be cleared on the same tick that reaches zero. */
    let remaining = seconds;

    const tick = setInterval(() => {
      remaining -= 1;
      setLeft(remaining);

      if (remaining <= 0) clearInterval(tick);
    }, 1000);

    return () => {
      clearInterval(tick);
    };
  }, [seconds]);

  return left;
};

/** The countdown, split out so the hook runs on every render rather than conditionally. */
const Waiting = ({ seconds, onRetry }: { seconds: number; onRetry: () => void }) => {
  const t = useT();
  const left = useCountdown(seconds);

  return (
    <div class="notice" role="status">
      <span class="notice-text">
        {left > 0 ? t('rateLimited', { seconds: left }) : t('rateLimitedReady')}
      </span>
      <button type="button" class="notice-retry" onClick={onRetry} disabled={left > 0}>
        {t('retry')}
      </button>
    </div>
  );
};

export const Notice = ({ state, onRetry }: NoticeProps) => {
  const t = useT();
  const key = noticeKeyOf(state);

  if (key === undefined) return null;

  /*
   * The only state with a moving part. Kept in its own component so its hooks
   * are not called from inside a branch, which is the rule Preact enforces by
   * breaking quietly rather than loudly.
   */
  if (state.k === 'rateLimited') return <Waiting seconds={state.retryAfter} onRetry={onRetry} />;

  return (
    <div class="notice" role="status">
      <span class="notice-text">{t(key)}</span>
      {isRetryable(state) && (
        <button type="button" class="notice-retry" onClick={onRetry}>
          {t('retry')}
        </button>
      )}
    </div>
  );
};
