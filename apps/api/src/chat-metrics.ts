/**
 * The metric names the chat route emits (P2-28).
 *
 * **Re-declared here rather than imported from `infra/`**, which is not a
 * package and is not in this app's module graph — and must not be, since it
 * constructs AWS resources at import. The agreement is held by
 * `infra/test/chat-metrics.test.ts`, which imports both and fails on drift: a
 * guard that can fail, rather than an import that cannot exist.
 */

export const CHAT_METRIC_NAMESPACE = 'Catalogorosso/Chat';
export const CHAT_TURNS_METRIC = 'Turns';
export const CHAT_ESCALATIONS_METRIC = 'Escalations';
