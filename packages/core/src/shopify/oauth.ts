import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Installing the Shopify app (P6-06): the parts of OAuth that are rules
 * rather than plumbing.
 *
 * **Two checks, and skipping either is install forgery.** The callback's HMAC
 * proves Shopify sent this redirect — the code, the shop and the state are
 * signed with our app secret, so none of them can be chosen by whoever is
 * driving the browser. The `state` proves *we* started this install, for this
 * member of this winery, minutes ago and once: without it, an attacker starts
 * an install for their own winery and walks a seller's browser through the
 * consent, connecting the seller's shop to the attacker's account. Both are
 * checked; neither substitutes for the other.
 *
 * **The shop is held to `*.myshopify.com` before anything is sent to it.** The
 * token exchange posts our client secret to the shop, so a shop that is not
 * Shopify's would be our secret posted to a stranger.
 */

/** What the app asks for: the catalogue (P6-11) and the orders (P6-07). Nothing that writes. */
export const SHOPIFY_SCOPES = ['read_products', 'read_orders'] as const;

/** How long a started install may take to come back. Consent is a click or two. */
export const SHOPIFY_STATE_TTL_MS = 10 * 60 * 1000;

/** A shop's permanent name, as Shopify gives it: lowercase, one label, then the zone. */
const SHOP = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/u;

/**
 * The shop a seller typed, as Shopify names it — `cantina-rossi`,
 * `cantina-rossi.myshopify.com` or the admin URL all mean
 * `cantina-rossi.myshopify.com` — or `undefined` for anything that is not one.
 * A storefront's own domain is not accepted: it does not say which shop it is.
 */
export const normaliseShop = (input: string): string | undefined => {
  const trimmed = input.trim().toLowerCase();
  const host = /^https?:\/\//u.test(trimmed)
    ? (() => {
        try {
          return new URL(trimmed).hostname;
        } catch {
          return '';
        }
      })()
    : (trimmed.split('/')[0] ?? '');
  const shop = host.includes('.') ? host : `${host}.myshopify.com`;

  return SHOP.test(shop) ? shop : undefined;
};

/** Whether a value is already a shop's permanent name — what a signed callback or webhook carries. */
export const isShopDomain = (value: string): boolean => SHOP.test(value);

export const SHOP_EXPECTED =
  'Give your Shopify store as its myshopify.com address — for example ' +
  'cantina-rossi.myshopify.com. You will find it under Settings → Domains in Shopify.';

/** A fresh state nonce, and the hash of it that is stored: the nonce itself is never kept. */
export const newStateNonce = (): { readonly nonce: string; readonly hash: string } => {
  const nonce = randomBytes(32).toString('base64url');

  return { nonce, hash: stateHash(nonce) };
};

export const stateHash = (nonce: string): string =>
  createHash('sha256').update(nonce).digest('hex');

/** Where to send the seller: Shopify's consent screen for this shop, coming back to us. */
export const authorizeUrl = ({
  shop,
  clientId,
  redirectUri,
  state,
}: {
  readonly shop: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
}): string => {
  const url = new URL(`https://${shop}/admin/oauth/authorize`);

  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', SHOPIFY_SCOPES.join(','));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);

  return url.toString();
};

const sameBytes = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/**
 * Whether Shopify signed this callback.
 *
 * Every parameter but `hmac`, sorted by name, as `name=value` joined by `&`,
 * HMAC-SHA256 under the app secret, compared as hex in constant time.
 * Parameters are compared as received. A name given twice is refused by the
 * signature itself, with no check of its own: it appears twice in the message,
 * which Shopify never signs, so the HMAC cannot match.
 */
export const verifyCallbackHmac = (params: URLSearchParams, secret: string): boolean => {
  const given = params.get('hmac');

  if (given === null || !/^[0-9a-f]{64}$/u.test(given)) return false;

  const names = [...params.keys()];

  const message = names
    .filter((name) => name !== 'hmac')
    .sort()
    .map((name) => `${name}=${params.get(name) ?? ''}`)
    .join('&');

  return sameBytes(
    Buffer.from(createHmac('sha256', secret).update(message).digest('hex')),
    Buffer.from(given),
  );
};

/**
 * Whether Shopify signed this webhook: the raw body, HMAC-SHA256 under the app
 * secret, base64, in `X-Shopify-Hmac-Sha256`. Over the bytes as received,
 * never a re-serialisation (P5-03's reason).
 */
export const verifyWebhookHmac = (
  body: string,
  header: string | undefined,
  secret: string,
): boolean => {
  if (header === undefined || header === '') return false;

  return sameBytes(
    createHmac('sha256', secret).update(body, 'utf8').digest(),
    Buffer.from(header, 'base64'),
  );
};

/** Whether what the shop granted covers what the app needs. A narrower grant is refused. */
export const scopesCovered = (granted: string): boolean => {
  const held = new Set(
    granted
      .split(',')
      .map((scope) => scope.trim())
      .filter((scope) => scope !== ''),
  );

  return SHOPIFY_SCOPES.every((scope) => held.has(scope));
};
