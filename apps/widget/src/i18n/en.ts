import type { Messages } from './it.js';

/**
 * English (P3-14).
 *
 * **Typed as `Messages`, which is what makes a missing translation a build
 * failure** rather than a widget that renders `undefined` at a shopper. The
 * suite checks the same thing at runtime, because a type is only as good as the
 * next person's willingness not to reach for `as`.
 */
export const en: Messages = {
  composerLabel: 'Ask the sommelier',
  composerPlaceholder: 'What wine would you recommend?',
  send: 'Send',
  retry: 'Try again',

  disabled: 'The AI sommelier is not available right now.',
  quota: 'The sommelier is resting. Come back soon!',
  rateLimited: 'One moment. Try again in {seconds} s.',
  rateLimitedReady: 'Ready. You can try again.',
  errorProvider: 'I cannot answer right now.',
  errorNetwork: 'The connection dropped.',
};
