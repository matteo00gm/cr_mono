import { z } from 'zod';

import { STRIPE_TENANT_KEY } from './checkout.js';

/**
 * Reading Stripe events (P5-04, P5-05).
 *
 * Signature-verified already (P5-03); what arrives here is Stripe's, and the
 * question is only what it says. Written against the pinned API version
 * (`STRIPE_API_VERSION`), which is also the version the webhook endpoint must
 * be created on — an endpoint on another version sends other shapes.
 */

/** The shape of a tenant id: `withTenant`'s rule, and nothing looser. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const metadata = z.record(z.string(), z.unknown()).nullish();

/**
 * The three places an event can carry the winery P5-02 wrote into it.
 *
 * `client_reference_id` and `metadata` on a Checkout session; `metadata` on a
 * subscription; and, on an invoice, the metadata of the subscription it bills,
 * which Stripe moved to `parent.subscription_details` in 2025. Everything else
 * in the object is ignored here.
 */
const attributed = z.object({
  data: z.object({
    object: z.object({
      client_reference_id: z.string().nullish(),
      metadata,
      parent: z.object({ subscription_details: z.object({ metadata }).nullish() }).nullish(),
    }),
  }),
});

/**
 * The winery a verified Stripe event names, or `undefined` (ADR 0029).
 *
 * **The one place a tenant id is read from a request body**, and only because
 * we wrote it: P5-02 puts the session's own tenant into Stripe-signed data at
 * Checkout, and the browser never supplies it. It is read strictly —
 *
 * - under `tenant_id` and `client_reference_id` only, never a `tenantId` or any
 *   other spelling somebody could add;
 * - as a string in `withTenant`'s UUID shape, and nothing else;
 * - consistently: an event whose places disagree names nobody, because one of
 *   them is not ours.
 *
 * An event that names nobody changes nothing. The caller still binds the
 * winery it names to the customer on file before applying anything (P5-05).
 */
export const tenantOfStripeEvent = (payload: unknown): string | undefined => {
  const parsed = attributed.safeParse(payload);

  if (!parsed.success) return undefined;

  const { client_reference_id, metadata: own, parent } = parsed.data.data.object;
  const named = [
    client_reference_id,
    own?.[STRIPE_TENANT_KEY],
    parent?.subscription_details?.metadata?.[STRIPE_TENANT_KEY],
  ].filter((value) => value !== undefined && value !== null);

  const [first] = named;

  if (typeof first !== 'string' || !UUID.test(first)) return undefined;
  if (named.some((value) => value !== first)) return undefined;

  return first;
};
