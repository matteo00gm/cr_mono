import {
  NotFoundError,
  UnauthenticatedError,
  isUnreadableWebhookPayload,
  verifyStripeSignature,
  verifySvixSignature,
  type SignatureFailure,
} from '@catalogorosso/core';
import { publicRoute, type RouteAccess } from '@catalogorosso/security';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '../env.js';
import { routeKey } from '../middleware/capability.js';
import { logger } from '../middleware/logger.js';
import { WEBHOOK_PREFIX } from '../routes.js';
import { unconfiguredStripeEvents, type StripeEventsPort } from '../stripe-events.js';
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

  /**
   * The Stripe endpoint signing secret, `whsec_…` (P5-03). Absent is
   * restrictive on `resendWebhookSecret`'s terms: nothing can be verified, so
   * the endpoint answers 404 and nothing about a winery's billing moves.
   */
  readonly stripeWebhookSecret?: string | undefined;
  readonly stripeEvents?: StripeEventsPort | undefined;

  /**
   * Told of every delivery refused for its signature, whichever provider it
   * claimed to be from (P5-03). A `security_events` row in production.
   *
   * **It can never fail the request**: it is not awaited, and a rejection is
   * logged and dropped. A security log that errors must not become a way to
   * change the answer, or to slow it — the refusal is the same 401 either way.
   */
  readonly onSignatureRejected?: ((rejection: SignatureRejection) => Promise<void>) | undefined;
}

export interface SignatureRejection {
  readonly provider: 'resend' | 'stripe';
  readonly reason: SignatureFailure;
}

/** Stripe's one header. Lowercase: Hono normalises on lookup. */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

/**
 * All the route reads of an event before handing it on: its id, which is the
 * idempotency key, and its type. The rest is the event reader's (P5-05), which
 * knows what each type carries.
 */
const stripeEnvelope = z.object({ id: z.string().min(1), type: z.string().min(1) });

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
  stripeWebhookSecret,
  stripeEvents = unconfiguredStripeEvents,
  onSignatureRejected,
}: WebhookOptions): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  /** Logs the specific reason, records the refusal, and never lets either change the answer. */
  const rejected = (rejection: SignatureRejection): never => {
    /*
     * The reason travels under `type`, an allowlisted key whose documented
     * purpose is classification, for the reason given on the Resend route.
     */
    logger.warn(
      { kind: 'webhook_signature_rejected', type: rejection.reason },
      `a ${rejection.provider} delivery failed signature verification (P0-64b, P5-03)`,
    );

    const unrecorded = () => {
      logger.warn(
        { kind: 'webhook_rejection_unrecorded', type: rejection.reason },
        'a refused webhook delivery went unrecorded',
      );
    };

    try {
      onSignatureRejected?.(rejection).catch(unrecorded);
    } catch {
      unrecorded();
    }

    throw new UnauthenticatedError(REJECTED);
  };

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
      rejected({ provider: 'resend', reason: verified.reason });
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

  /**
   * Stripe billing events (P5-03).
   *
   * **The raw body, verified, and only then parsed** — the Resend route's
   * order and its reason: a signature over a re-serialisation of the payload
   * is a signature over bytes Stripe never sent. Nothing above this surface
   * parses a body, and `webhooks.test.ts` fails if anything starts to.
   *
   * No session, no tenant and no CORS: its own `Hono` instance (see the top of
   * this file). Which winery an event is about is the event's to say, inside
   * the signed body, and the port checks it against the customer on file.
   */
  app.post('/stripe', async (c) => {
    if (stripeWebhookSecret === undefined || stripeWebhookSecret.trim() === '') {
      logger.warn(
        { kind: 'webhook_unconfigured' },
        'a Stripe event arrived with no signing secret configured (P5-03)',
      );

      throw new NotFoundError('Not found.');
    }

    const body = await c.req.text();

    const verified = verifyStripeSignature({
      secret: stripeWebhookSecret,
      header: c.req.header(STRIPE_SIGNATURE_HEADER),
      body,
    });

    if (!verified.ok) rejected({ provider: 'stripe', reason: verified.reason });

    /*
     * Signed and unreadable is Stripe changing a shape under us, not a caller
     * mistake: acknowledged, so it is not redelivered for three days to no
     * purpose, and logged for the alarm — the Resend route's reasoning.
     */
    let payload: unknown;

    try {
      payload = JSON.parse(body);
    } catch {
      return acknowledgeUnreadableStripe(c, 'webhook_body_not_json');
    }

    const envelope = stripeEnvelope.safeParse(payload);

    if (!envelope.success) return acknowledgeUnreadableStripe(c, 'webhook_payload_unreadable');

    /*
     * A failure past this point — a database that is down, an unwired port —
     * is left to become a 500, which Stripe retries. That is the case where a
     * redelivery repairs something, and P5-04's ledger makes it safe.
     */
    const result = await stripeEvents.record({
      eventId: envelope.data.id,
      type: envelope.data.type,
      payload,
    });

    return c.json({
      received: true as const,
      type: envelope.data.type,
      duplicate: result.duplicate,
      applied: result.applied,
    });
  });

  return app;
};

/** `acknowledgeUnreadable`, for Stripe: no suppression count, because there is no suppression. */
const acknowledgeUnreadableStripe = (
  c: Context<AppEnv>,
  kind: 'webhook_body_not_json' | 'webhook_payload_unreadable',
) => {
  logger.warn({ kind }, 'a signed Stripe event could not be read (P5-03)');

  return c.json({ received: true as const, type: 'unreadable' as const });
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
  [
    routeKey('POST', `${WEBHOOK_PREFIX}/stripe`),
    publicRoute(
      'Public in the sense that it carries no session and no tenant, and authenticated ' +
        "in the sense that matters: Stripe's HMAC-SHA256 signature over the timestamp and " +
        'the raw body, with a five-minute tolerance. An unsigned or mis-signed request is ' +
        'refused before the body is parsed and recorded as a security event. The winery an ' +
        'event is about is read from inside the signed body and checked against the ' +
        'customer on file; nothing a caller could choose decides it.',
    ),
  ],
]);
