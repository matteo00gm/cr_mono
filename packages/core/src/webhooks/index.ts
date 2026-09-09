/**
 * Inbound webhooks (P0-64b).
 *
 * The signature verifier is provider-shaped and the event reader is
 * Resend-shaped, and they are separate files for that reason: P0-33's Stripe
 * handler shares the first kind of thing and shares nothing of the second.
 */
export {
  TIMESTAMP_TOLERANCE_SEC,
  verifySvixSignature,
  type SignatureFailure,
  type SignatureResult,
  type SvixHeaders,
  type VerifyOptions,
} from './signature.js';

export {
  isUnreadableWebhookPayload,
  suppressionsFor,
  UnreadableWebhookPayloadError,
  type EventOutcome,
  type ResendEvent,
  type Suppression,
} from './resend.js';
