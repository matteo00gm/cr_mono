import { z } from 'zod';

import { isShopDomain } from './oauth.js';

/**
 * Shopify's privacy requests (P6-09b): a customer asks what a shop's apps hold
 * about them, or asks for it to be erased, or a shop that removed the app has
 * its customers' data erased 48 hours later.
 *
 * **Every app in the Shopify App Store must answer all three.** What this
 * service holds that can be tied to a customer is narrow by design (P6-07):
 * no name, no address, no email — only that an order's line was one the
 * sommelier sold, and through that, which conversation led to it. So each
 * request comes down to a list of orders.
 *
 * **The shop is read from the signed body here, not from the header.** Every
 * other topic uses the header to *find* an installation and does nothing a
 * wrong shop could be hurt by. These erase. A delivery replayed under another
 * shop's header would erase that shop's records, so the body — which is what
 * the signature covers — says whose request it is, and the header has to
 * agree.
 *
 * **Nothing about the customer is read**, though the body names them: an id,
 * an email, a phone number. The readers below take the shop and the orders,
 * and the rest goes no further (P6-07's rule, for the same reason).
 */

/** An order, in every spelling a sale may have been recorded under (P6-08). */
const spellingsOf = (order: unknown): string[] =>
  typeof order === 'number' && Number.isSafeInteger(order) && order > 0
    ? [`gid://shopify/Order/${String(order)}`, String(order)]
    : [];

const shopOf = (value: unknown): string | undefined =>
  typeof value === 'string' && isShopDomain(value) ? value : undefined;

const customerRequest = z.object({
  shop_domain: z.unknown(),
  orders_to_redact: z.array(z.unknown()).max(10_000).optional(),
  orders_requested: z.array(z.unknown()).max(10_000).optional(),
  data_request: z.object({ id: z.unknown() }).optional(),
});

export interface CustomerRequest {
  /** The shop the request is for, from the signed body. */
  readonly shop: string;
  /** The customer's orders, each in both spellings. Empty when Shopify named none. */
  readonly orderIds: readonly string[];
  /** Shopify's id for a data request, to answer it by; absent on an erasure. */
  readonly requestId: string | undefined;
}

/**
 * The orders a customer's request is about — `customers/redact` names the
 * orders to erase, `customers/data_request` the orders asked after — or
 * `undefined` when the body is not one we can read.
 */
export const readCustomerRequest = (body: string): CustomerRequest | undefined => {
  let json: unknown;

  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }

  const parsed = customerRequest.safeParse(json);

  if (!parsed.success) return undefined;

  const shop = shopOf(parsed.data.shop_domain);

  if (shop === undefined) return undefined;

  const orders = [...(parsed.data.orders_to_redact ?? []), ...(parsed.data.orders_requested ?? [])];
  const request = parsed.data.data_request?.id;

  return {
    shop,
    orderIds: orders.flatMap(spellingsOf),
    requestId:
      typeof request === 'number' && Number.isSafeInteger(request) && request > 0
        ? String(request)
        : undefined,
  };
};

/** The shop a `shop/redact` is for, from the signed body — or `undefined`. */
export const readShopRedact = (body: string): string | undefined => {
  try {
    const json: unknown = JSON.parse(body);

    return typeof json === 'object' && json !== null
      ? shopOf((json as { shop_domain?: unknown }).shop_domain)
      : undefined;
  } catch {
    return undefined;
  }
};
