/**
 * Email (P0-64).
 *
 * The public surface is `createSendEmail` and the transports. Templates are
 * exported for the tests and for a future preview route, not so that callers
 * can render one and send it themselves — doing that bypasses the suppression
 * check, which is the part of this module that protects the sending domain.
 */
export { looksLikeAddress, normaliseAddress } from './address.js';
export { escapeHtml, UnsafeEmailUrlError, type Block, type RenderedEmail } from './render.js';
export {
  LOCALES,
  TEMPLATE_NAMES,
  renderTemplate,
  type Locale,
  type TemplateName,
  type TemplateProps,
} from './templates.js';
export {
  chooseTransport,
  EmailSendError,
  logTransport,
  resendTransport,
  type EmailTransport,
  type OutboundEmail,
  type SendResult,
} from './transport.js';
export {
  createSendEmail,
  InvalidRecipientError,
  noSuppression,
  type SendEmail,
  type SendEmailDeps,
  type SendEmailOptions,
  type SendFailure,
  type SendOutcome,
  type SuppressionCheck,
} from './send.js';
