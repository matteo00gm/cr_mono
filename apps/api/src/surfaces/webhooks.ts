import {
  NotFoundError,
  UnauthenticatedError,
  isUnreadableWebhookPayload,
  verifySvixSignature,
} from '@catalogorosso/core';
import { publicRoute, type RouteAccess } from '@catalogorosso/security';
import { Hono, type Context } from 'hono';

import type { AppEnv } from '../env.js';
import { routeKey } from '../middleware/capability.js';
import { logger } from '../middleware/logger.js';
import { WEBHOOK_PREFIX } from '../routes.js';
import { unconfiguredWebhooks, type WebhooksPort } from '../webhooks.js';

/**
 * The webhook surface — `/v1/webhooks/*` (P0-64b).
 *
 * **The third surface, and it shares nothing with the other two.** The
 * dashboard authenticates a person by session cookie and scopes them to a
 * tenant from `memberships`; the widget authenticates a site by an
 * origin-bound token. Here there is no person, no tenant and no origin — a
 * provider POSTs to us, and the only evidence that it is really them is an HMAC
 * over the bytes they sent.
 *
 * Its own `Hono` instance for exactly the reason the other two are separate.
 * `requireUser` mounted anywhere above this would reject every delivery — which
 * would at least be loud — and the widget's permissive CORS reaching it would
 * be the quiet version of the same mistake. Structure, rather than a rule
 * reviewers have to remember.
 *
 * P0-33's Stripe handler mounts here beside `/resend` with its own verifier,
 * which is the reason this is a surface with a prefix rather than one route
 * hung off the dashboard.
 *
 * **Not in the OpenAPI document, deliberately.** P0-62 generates a reference
 * for the people who call our API; this endpoint is called by a provider we
 * configured, whose contract is theirs and not ours. Publishing it would
 * describe a URL nobody should be posting to as though it were an offer.
 */

export interface WebhookOptions {
  /**
   * The Resend endpoint signing secret, `whsec_…`.
   *
   * **Absent is restrictive, not permissive**, which is the opposite of
   * `originSecret` and is why this needs no startup guard to be safe: with no
   * secret there is nothing to verify against, so every delivery is refused.
   * What absence costs is function rather than safety — bounces stop being
   * recorded — and `index.ts` says so in a startup warning, because E7's whole
   * lesson is that an empty suppression list looks exactly like a domain with
   * no bounces.
   */
  readonly resendWebhookSecret?: string | undefined;
  readonly webhooks?: WebhooksPort | undefined;
}

/** Svix's three headers. Lowercase: Hono normalises on lookup. */
export const SVIX_ID_HEADER = 'svix-id';
export const SVIX_TIMESTAMP_HEADER = 'svix-timestamp';
export const SVIX_SIGNATURE_HEADER = 'svix-signature';

/**
 * One message for every rejection, and the specific reason only in the log.
 *
 * A `DomainError`'s message reaches the caller verbatim (P0-55). Telling an
 * unauthenticated caller *which* part of their forgery failed — the timestamp,
 * the parse, the comparison — is a tutorial, and it helps the one legitimate
 * caller not at all, because Resend's dashboard shows them the status code and
 * we control both ends of the real integration.
 */
const REJECTED = 'Signature verification failed.';

/**
 * Acknowledges a delivery we cannot read, and says so in the log.
 *
 * **200 for a malformed payload is the deliberate part, and it is a correction
 * of the obvious answer.** The instinct is 400 — the body really is bad — and
 * the reasoning behind it is that a 4xx is final while a 5xx is retried. That
 * is not how Svix works: *every* non-2xx is retried on a schedule spanning
 * hours, and an endpoint that keeps failing is eventually disabled. So a 400
 * here would buy nothing, cost eight redeliveries of a payload that will never
 * become readable, and push the endpoint toward being switched off — which is
 * E7 again, arrived at from the other direction, with the suppression list
 * silently ceasing to fill.
 *
 * The status is therefore chosen by whether a retry can help: it cannot here,
 * and it can when the database is down, which is why that case is left alone to
 * become a 500.
 *
 * What replaces the 4xx is the log line. The request is signature-verified, so
 * an unreadable payload means Resend changed a shape and *our* reader is out of
 * date — an actionable engineering signal rather than a caller error, and one
 * an alarm can filter on by `kind` alongside P0-64's bounce-rate alarm.
 */
const acknowledgeUnreadable = (
  c: Context<AppEnv>,
  kind: 'webhook_body_not_json' | 'webhook_payload_unreadable',
) => {
  logger.warn({ kind }, 'a signed delivery event could not be read (P0-64b)');

  return c.json({ received: true as const, type: 'unreadable' as const, suppressed: 0 });
};

export const createWebhookApp = ({
  resendWebhookSecret,
  webhooks = unconfiguredWebhooks,
}: WebhookOptions): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  /**
   * Resend delivery events (P0-64b).
   *
   * The order of the four steps below is the security property, not a style:
   * the body is read as **text**, verified, and only then parsed. A handler
   * that started from `c.req.json()` would be verifying a re-serialisation of
   * the payload rather than the bytes Resend signed — different key order,
   * different number formatting, different whitespace — so the check would fail
   * for every legitimate delivery, and the natural way to make it pass is to
   * loosen it until it proves nothing.
   */
  app.post('/resend', async (c) => {
    if (resendWebhookSecret === undefined || resendWebhookSecret.trim() === '') {
      /*
       * 404 rather than 500: with no secret configured this endpoint genuinely
       * does not exist yet, and saying so is both true and the least useful
       * thing to tell somebody probing for it. The operator sees it as failed
       * deliveries in Resend's dashboard, which is where they are looking on
       * the day they set this up.
       */
      logger.warn(
        { kind: 'webhook_unconfigured' },
        'a delivery event arrived with no signing secret configured (P0-64b)',
      );

      throw new NotFoundError('Not found.');
    }

    const body = await c.req.text();

    const verified = verifySvixSignature({
      secret: resendWebhookSecret,
      headers: {
        id: c.req.header(SVIX_ID_HEADER),
        timestamp: c.req.header(SVIX_TIMESTAMP_HEADER),
        signature: c.req.header(SVIX_SIGNATURE_HEADER),
      },
      body,
    });

    if (!verified.ok) {
      /*
       * The reason travels under `type`, an allowlisted key whose documented
       * purpose is classification — **not** under a new `reason` key. Adding a
       * name to the P0-56 allowlist opens it at every depth for every caller
       * (D8), and `SignatureFailure` is a closed set of five literals that
       * cannot carry a secret, so an existing key does the job exactly.
       */
      logger.warn(
        { kind: 'webhook_signature_rejected', type: verified.reason },
        'a delivery event failed signature verification (P0-64b)',
      );

      throw new UnauthenticatedError(REJECTED);
    }

    /*
     * Only now is the body treated as data. `svix-id` is verified — it is
     * inside the signed content — so it is safe to use as the idempotency key,
     * which an id read out of the payload would not be.
     */
    const eventId = c.req.header(SVIX_ID_HEADER) ?? '';

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return acknowledgeUnreadable(c, 'webhook_body_not_json');
    }

    try {
      const result = await webhooks.record({ eventId, payload });

      /*
       * `suppressed` is a count, never the addresses. The response goes back to
       * a provider that already knows them, so echoing them buys nothing and
       * puts an address into a body that ends up in their logs as well as ours.
       */
      return c.json({
        received: true as const,
        type: result.type,
        suppressed: result.suppressions.length,
        duplicate: result.duplicate,
      });
    } catch (error) {
      if (isUnreadableWebhookPayload(error)) {
        return acknowledgeUnreadable(c, 'webhook_payload_unreadable');
      }

      /*
       * Everything else — a database that is down — is left to become a 500,
       * and that is the case where a redelivery genuinely repairs something.
       * The ledger is what makes that safe: the claim and the suppression share
       * a transaction, so a failed attempt leaves nothing claimed and the retry
       * applies cleanly.
       */
      throw error;
    }
  });

  return app;
};

/**
 * Access for the webhook surface (P0-49).
 *
 * Its own table rather than a row in the dashboard's, because the boot check
 * runs per prefix — and because these are not routes a *role* can hold a
 * capability for. There is no session here at all, so "public" is the only
 * honest declaration and the reason has to carry the real answer.
 */
export const WEBHOOK_ROUTE_ACCESS: ReadonlyMap<string, RouteAccess> = new Map<string, RouteAccess>([
  [
    routeKey('POST', `${WEBHOOK_PREFIX}/resend`),
    publicRoute(
      'Public in the sense that it carries no session and no tenant, and authenticated ' +
        'in the sense that matters: an HMAC-SHA256 signature over the raw body, with the ' +
        'message id and timestamp inside the signed content and a five-minute tolerance. ' +
        'An unsigned or mis-signed request is refused before the body is parsed. Applied ' +
        'exactly once per event id, because providers redeliver.',
    ),
  ],
]);
