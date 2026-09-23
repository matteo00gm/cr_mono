export * from './config.js';
export * from './errors.js';
export * from './auth.js';
export * from './members.js';
export * from './request-context.js';
export * from './audit.js';
export * from './email/index.js';
export * from './invitations.js';
export * from './rate-limit.js';
export * from './webhooks/index.js';
export * from './rag/index.js';
export * from './completeness.js';
export * from './import-limits.js';

/**
 * What a turn cost (P2-31).
 *
 * The price table is checked in, so a bill a seller disputes is settled by
 * reading the table as of that deploy — and an unpriced model throws rather
 * than metering at nought.
 */
export {
  assertModelPriced,
  CHAT_MESSAGE,
  costMicrosFor,
  MODEL_PRICES,
  periodOf,
  UnpricedModelError,
  type ModelPrice,
  type TurnCost,
} from './usage.js';

/**
 * The monthly plan cap (P2-36).
 *
 * The actual cost gate: per-minute limits protect the infrastructure from a
 * burst, and this is the only thing standing between a runaway tenant and an
 * unbounded bill.
 */
export {
  checkQuota,
  OVERAGE_ALLOWANCE,
  QUOTA_EXCEEDED_MESSAGE,
  type QuotaDecision,
  type QuotaQuestion,
} from './quota.js';

/**
 * The Shopify variant id (P3-11).
 *
 * Normalised at the two writes rather than at the cart, because the failure it
 * prevents happens on a visitor's screen and is invisible in the console.
 */
export { readVariantId, VARIANT_ID_EXPECTED, type VariantId } from './shopify/variant-id.js';
