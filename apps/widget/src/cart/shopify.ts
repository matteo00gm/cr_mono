/**
 * Shopify's own AJAX cart (P3-11, §1.6).
 *
 * **Relative URLs, always.** `/cart/add.js` is the *host page's* endpoint, not
 * ours, and it is the seller's own session that owns the cart. An absolute URL
 * pointing anywhere else adds a wine to nobody's basket.
 *
 * **The session property ships now, though nothing reads it yet.** Every line
 * we add carries `_somm_session`, which is what makes P6-07's order attribution
 * possible. Attribution cannot be reconstructed after the fact: an order placed
 * today without the property is an order we can never claim credit for, so the
 * cost of shipping it early is nothing and the cost of shipping it late is
 * every sale in between.
 */

/** Shopify's endpoints, on the host page's origin. */
export const ADD_PATH = '/cart/add.js';
export const CART_PATH = '/cart.js';

/** The line-item property that makes revenue attribution possible later (§2.4). */
export const SESSION_PROPERTY = '_somm_session';

export interface AddOptions {
  /** The numeric Shopify variant id, already normalised by `readVariantId` (P3-11). */
  readonly variantId: string;
  readonly quantity?: number | undefined;
  /** Our widget session, so an order can be traced back to the conversation. */
  readonly sessionId: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

/**
 * A refusal a shopper can be told about.
 *
 * Shopify answers 422 with a `description` for a sold-out variant, and that
 * sentence is written for a shopper in the shop's own language — far better
 * than anything we would invent, so it is passed through.
 */
export class ShopifyRefused extends Error {
  constructor(
    readonly status: number,
    /** Shopify's own wording, when it sent one. */
    readonly description?: string,
  ) {
    super(description ?? `Shopify refused with ${String(status)}.`);
    this.name = 'ShopifyRefused';
  }
}

/** What Shopify sends back when it refuses. Read defensively: it is not our contract. */
const descriptionIn = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;

  const shape = body as { description?: unknown; message?: unknown };

  if (typeof shape.description === 'string' && shape.description !== '') return shape.description;
  if (typeof shape.message === 'string' && shape.message !== '') return shape.message;

  return undefined;
};

/**
 * Adds one line to the shopper's cart.
 *
 * **`credentials: 'same-origin'`, because the cart *is* the cookie.** This is
 * the one request in the widget that must carry one: Shopify's cart lives in
 * the host page's session, and a request without it creates a cart the shopper
 * will never see. Our own surface is the opposite and says so (P2-08).
 */
export const addToShopifyCart = async ({
  variantId,
  quantity = 1,
  sessionId,
  fetch: fetch_ = globalThis.fetch,
}: AddOptions): Promise<void> => {
  const response = await fetch_(ADD_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      items: [{ id: variantId, quantity, properties: { [SESSION_PROPERTY]: sessionId } }],
    }),
  });

  if (response.ok) return;

  /* A refusal that is not JSON is still a refusal; the status is what we have. */
  const body: unknown = await response.json().catch(() => undefined);

  throw new ShopifyRefused(response.status, descriptionIn(body));
};

/**
 * How many items are in the cart now.
 *
 * **Read back rather than counted up.** A shopper may have added wines in
 * another tab, or removed them in the shop's own cart drawer, so a number we
 * incremented ourselves would drift and be wrong in a way nobody could explain.
 * A failure answers `undefined`: the count is a nicety, and a badge that is
 * absent is better than a widget that broke over one.
 */
export const shopifyCartCount = async (
  fetch_: typeof globalThis.fetch = globalThis.fetch,
): Promise<number | undefined> => {
  try {
    const response = await fetch_(CART_PATH, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });

    if (!response.ok) return undefined;

    const body: unknown = await response.json();
    const count = (body as { item_count?: unknown }).item_count;

    return typeof count === 'number' ? count : undefined;
  } catch {
    return undefined;
  }
};
