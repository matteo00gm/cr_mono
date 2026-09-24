import type { ChatFailure } from './conversation.js';
import type { Messages } from './i18n/index.js';

/**
 * The five states (P3-07, §1.3).
 *
 * **One discriminated union drives the whole UI**, so a state nobody handled is
 * a type error rather than a blank panel on a seller's storefront. That is the
 * row's whole argument, and it is the reason `ChatFailure` is three of these
 * five rather than a parallel vocabulary: two unions describing the same screen
 * is how a case gets handled in one and forgotten in the other.
 *
 * **Nothing here names a plan, a price or a count** (§1.3). A shopper is not
 * our customer, and what a winery pays is not theirs to be told — which is also
 * why `rateLimited` carries seconds and `quota` carries nothing at all.
 */
export type WidgetState = { readonly k: 'active' } | { readonly k: 'disabled' } | ChatFailure;

/**
 * What the widget is, right now.
 *
 * **A switched-off winery outranks everything.** The loader normally stops long
 * before this (P3-03) — no bundle, no session, no model call — but a seller can
 * lapse mid-session, and then the API starts answering `unavailable` to a page
 * that already has the chat open. The visitor is told the shop is not serving,
 * not that we are broken.
 */
export const stateFor = (
  status: 'ACTIVE' | 'DISABLED',
  failure: ChatFailure | undefined,
): WidgetState => {
  if (status !== 'ACTIVE') return { k: 'disabled' };

  return failure ?? { k: 'active' };
};

/**
 * Which sentence a state shows, or none.
 *
 * `active` has no notice because the chat is the notice. Exhaustive by
 * construction: a sixth state added to the union and not answered for here is a
 * compile error, which is the point of the union.
 */
export const noticeKeyOf = (state: WidgetState): keyof Messages | undefined => {
  switch (state.k) {
    case 'active':
      return undefined;
    case 'disabled':
      return 'disabled';
    case 'quota':
      return 'quota';
    case 'rateLimited':
      return 'rateLimited';
    case 'error':
      return state.cause === 'network' ? 'errorNetwork' : 'errorProvider';
  }
};

/**
 * Whether asking again is worth a visitor's time.
 *
 * A spent month is not, and neither is a shop that has switched the widget off:
 * a button that says otherwise wastes their time to tell them the same thing
 * again. `rateLimited` is retryable *eventually*, which the countdown handles.
 */
export const isRetryable = (state: WidgetState): boolean =>
  state.k === 'error' || state.k === 'rateLimited';

/** Whether the visitor can type. A state with no answer coming still takes questions. */
export const acceptsQuestions = (state: WidgetState): boolean =>
  state.k === 'active' || state.k === 'error';
