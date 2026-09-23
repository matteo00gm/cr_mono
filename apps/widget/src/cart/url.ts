/**
 * Where the cart button goes (P3-13, §1.6).
 *
 * **An open redirect driven by tenant config would be a real vulnerability**,
 * and the shape of it is worth writing down: the widget runs on a seller's own
 * storefront, and `cartUrl` comes from *our* configuration record. Anybody who
 * can write that record — a support tool, a compromised console session, a bug
 * in a settings form — could point every shopper of every winery at a phishing
 * page that the shopper reaches from a link inside the shop they trust.
 *
 * **Checked here as well as at configuration time.** Two checks for one rule is
 * deliberate: the one at write time is the one a seller sees and the one here
 * is the one that holds when a record was written before the rule existed, or
 * by something that bypassed the form.
 */

/** Where a shop's cart lives when nobody said otherwise. */
export const DEFAULT_CART_URL = '/cart';

/**
 * The cart URL, if it is one we may navigate the host page to.
 *
 * **Same origin or relative, and nothing else.** A `//evil.example/cart` is a
 * protocol-relative absolute URL that reads as a path and is not one, which is
 * exactly the shape a check written with `startsWith('/')` lets through — so
 * the test is what the URL parser says the origin is, after resolving.
 *
 * Anything refused falls back to `/cart`, because a shopper clicking a cart
 * button should reach *a* cart: the seller's own default is a better answer
 * than a dead button, and the misconfiguration is ours to notice, not theirs.
 */
export const safeCartUrl = (cartUrl: string | undefined, origin: string): string => {
  const candidate = (cartUrl ?? '').trim();

  if (candidate === '') return DEFAULT_CART_URL;

  try {
    const base = new URL(origin);
    const resolved = new URL(candidate, base);

    if (resolved.origin !== base.origin) return DEFAULT_CART_URL;

    /* Relative, so the host page navigates within itself whatever its origin. */
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return DEFAULT_CART_URL;
  }
};
