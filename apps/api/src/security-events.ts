import type { SecurityEvent, SecurityEventType } from '@catalogorosso/db';

import type { RejectedWidgetRequest } from './middleware/cors.js';
import type { RejectedWidgetToken } from './middleware/widget-auth.js';
import type { TokenRefusal } from './widget-token.js';

/**
 * What a refusal becomes in `security_events` (P2-16).
 *
 * **The decision about what is worth recording lives here**, in the app, while
 * the statement lives in `packages/db`. The guards report a refusal through a
 * hook that can never fail a request — a security log that errors must not
 * become a way to deny service — and this is the function that turns one of
 * those reports into a row.
 */

/** The statement, injected: `insertSecurityEvent` in production, a spy in a test. */
export type SecurityEventWriter = (event: SecurityEvent) => Promise<void>;

/**
 * Which type counts a token refusal.
 *
 * Two of them are a binding failure — a token minted for another site or
 * another winery — which is what `TOKEN_ORIGIN_MISMATCH` has always meant. The
 * rest are a token that did not verify at all. The exact reason travels in
 * `metadata`, because the type is the thing P6-05 groups by and a type per
 * reason would make that panel a histogram of implementation detail.
 */
const TOKEN_EVENT_TYPE: Readonly<Record<TokenRefusal, SecurityEventType>> = {
  absent: 'INVALID_TOKEN',
  invalid: 'INVALID_TOKEN',
  malformed: 'INVALID_TOKEN',
  revoked: 'INVALID_TOKEN',
  /*
   * A token for a session a seller ended by removing its domain (P4-06). Not
   * `TOKEN_ORIGIN_MISMATCH`: that type means a token presented at a site it was
   * not minted for, which is widget theft. This one was minted for exactly this
   * site, by us, and the site stopped being theirs — an ordinary consequence of
   * a seller's own action, and the exact reason still travels in `metadata`.
   */
  origin_removed: 'INVALID_TOKEN',
  origin_mismatch: 'TOKEN_ORIGIN_MISMATCH',
  tenant_mismatch: 'TOKEN_ORIGIN_MISMATCH',
};

export interface RefusalRecorders {
  /** For `widgetCors` (P2-08): an unknown key, or a key used from the wrong site. */
  readonly onRejected: (event: RejectedWidgetRequest) => Promise<void>;
  /** For `requireWidgetToken` (P2-13): every way a token can fail. */
  readonly onTokenRejected: (event: RejectedWidgetToken) => Promise<void>;
}

export const refusalRecorders = (write: SecurityEventWriter): RefusalRecorders => ({
  onRejected: (event) =>
    write({
      // The hook's own type is already one of the table's: an unknown key or a
      // key from an origin its tenant has not verified.
      type: event.type,
      tenantId: event.tenantId,
      origin: event.origin,
      publicKey: event.publicKey,
      ipBucket: event.ipBucket,
    }),

  onTokenRejected: (event) =>
    write({
      type: TOKEN_EVENT_TYPE[event.reason],
      tenantId: event.tenantId,
      origin: event.origin,
      ipBucket: event.ipBucket,
      metadata: { reason: event.reason },
    }),
});
