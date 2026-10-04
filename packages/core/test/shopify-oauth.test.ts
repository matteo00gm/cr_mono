import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  authorizeUrl,
  isShopDomain,
  newStateNonce,
  normaliseShop,
  scopesCovered,
  SHOPIFY_SCOPES,
  SHOPIFY_STATE_TTL_MS,
  stateHash,
  verifyCallbackHmac,
  verifyWebhookHmac,
} from '../src/shopify/oauth.js';

/**
 * The rules of the Shopify install (P6-06). The flow that applies them — the
 * state consumed once, the token exchanged and stored — is tested in
 * `apps/api`; these are the checks it cannot do without.
 */

/** Built at runtime, never written down (P0-56). */
const SECRET = ['shpss', 'test', 'a'.repeat(24)].join('_');

/** A callback as Shopify signs one. */
const signed = (params: Record<string, string>, secret = SECRET): URLSearchParams => {
  const message = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name] ?? ''}`)
    .join('&');
  const hmac = createHmac('sha256', secret).update(message).digest('hex');

  return new URLSearchParams({ ...params, hmac });
};

const CALLBACK = {
  code: 'code-1',
  shop: 'cantina-rossi.myshopify.com',
  state: 'tenant.nonce',
  timestamp: '1790000000',
  host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvY2FudGluYS1yb3NzaQ',
};

describe('normaliseShop', () => {
  it.each([
    ['cantina-rossi', 'cantina-rossi.myshopify.com'],
    ['cantina-rossi.myshopify.com', 'cantina-rossi.myshopify.com'],
    ['  Cantina-Rossi.MyShopify.com ', 'cantina-rossi.myshopify.com'],
    ['https://cantina-rossi.myshopify.com/admin', 'cantina-rossi.myshopify.com'],
    ['cantina-rossi.myshopify.com/admin/products', 'cantina-rossi.myshopify.com'],
  ])('reads %j as %s', (input, shop) => {
    expect(normaliseShop(input)).toBe(shop);
  });

  it.each([
    ['a storefront’s own domain, which does not say which shop it is', 'www.cantina-rossi.it'],
    ['a shop under somebody else’s zone', 'cantina.myshopify.com.evil.example'],
    ['a deeper name', 'a.b.myshopify.com'],
    ['nothing', ''],
    ['a leading hyphen', '-cantina'],
    ['an underscore', 'cantina_rossi'],
    ['a URL that is not one', 'https://'],
    ['a name too long to be a shop', 'a'.repeat(61)],
  ])('refuses %s', (_label, input) => {
    expect(normaliseShop(input)).toBeUndefined();
  });

  it('takes a name of sixty characters, Shopify’s own limit', () => {
    expect(normaliseShop('a'.repeat(60))).toBe(`${'a'.repeat(60)}.myshopify.com`);
  });
});

describe('isShopDomain', () => {
  it('is true only for a permanent name as Shopify sends it', () => {
    expect(isShopDomain('cantina-rossi.myshopify.com')).toBe(true);
    expect(isShopDomain('Cantina-Rossi.myshopify.com')).toBe(false);
    expect(isShopDomain('cantina-rossi')).toBe(false);
  });
});

describe('the state', () => {
  it('is a fresh nonce each time, of 256 bits', () => {
    const first = newStateNonce();
    const second = newStateNonce();

    expect(first.nonce).not.toBe(second.nonce);
    expect(Buffer.from(first.nonce, 'base64url')).toHaveLength(32);
  });

  it('is kept only as a hash', () => {
    const { nonce, hash } = newStateNonce();

    expect(hash).toBe(stateHash(nonce));
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).not.toContain(nonce);
  });

  it('lasts ten minutes', () => {
    expect(SHOPIFY_STATE_TTL_MS).toBe(600_000);
  });
});

describe('authorizeUrl', () => {
  it('sends the seller to their own shop’s consent, asking for reads only', () => {
    const url = new URL(
      authorizeUrl({
        shop: 'cantina-rossi.myshopify.com',
        clientId: 'client-1',
        redirectUri: 'https://app.catalogorosso.com/v1/dashboard/shopify/callback',
        state: 'tenant.nonce',
      }),
    );

    expect(url.origin).toBe('https://cantina-rossi.myshopify.com');
    expect(url.pathname).toBe('/admin/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'client-1',
      scope: 'read_products,read_orders',
      redirect_uri: 'https://app.catalogorosso.com/v1/dashboard/shopify/callback',
      state: 'tenant.nonce',
    });
    expect(SHOPIFY_SCOPES.every((scope) => scope.startsWith('read_'))).toBe(true);
  });
});

describe('verifyCallbackHmac', () => {
  it('accepts a callback Shopify signed', () => {
    expect(verifyCallbackHmac(signed(CALLBACK), SECRET)).toBe(true);
  });

  it.each(Object.keys(CALLBACK))('refuses one whose %s was changed', (name) => {
    const params = signed(CALLBACK);

    params.set(name, `${params.get(name) ?? ''}x`);

    expect(verifyCallbackHmac(params, SECRET)).toBe(false);
  });

  it('refuses one with a parameter added after signing', () => {
    const params = signed(CALLBACK);

    params.append('extra', '1');

    expect(verifyCallbackHmac(params, SECRET)).toBe(false);
  });

  it('refuses one signed with another secret', () => {
    expect(verifyCallbackHmac(signed(CALLBACK, `${SECRET}x`), SECRET)).toBe(false);
  });

  it('refuses one with no hmac, or one that is not hex of the right length', () => {
    const params = new URLSearchParams(CALLBACK);

    expect(verifyCallbackHmac(params, SECRET)).toBe(false);

    params.set('hmac', 'abc');
    expect(verifyCallbackHmac(params, SECRET)).toBe(false);

    params.set('hmac', 'G'.repeat(64));
    expect(verifyCallbackHmac(params, SECRET)).toBe(false);
  });

  it('refuses a name given twice, rather than guess which value was signed', () => {
    const params = signed(CALLBACK);

    params.append('shop', 'evil.myshopify.com');

    expect(verifyCallbackHmac(params, SECRET)).toBe(false);
  });

  it('signs a parameter with an empty value as Shopify does', () => {
    expect(verifyCallbackHmac(signed({ ...CALLBACK, host: '' }), SECRET)).toBe(true);
  });
});

describe('verifyWebhookHmac', () => {
  const BODY = JSON.stringify({ domain: 'cantina-rossi.myshopify.com' });
  const sign = (body: string, secret = SECRET) =>
    createHmac('sha256', secret).update(body, 'utf8').digest('base64');

  it('accepts a body Shopify signed', () => {
    expect(verifyWebhookHmac(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it('refuses a body changed after signing, by one byte', () => {
    expect(verifyWebhookHmac(`${BODY} `, sign(BODY), SECRET)).toBe(false);
  });

  it('refuses another secret, no header, and an empty one', () => {
    expect(verifyWebhookHmac(BODY, sign(BODY, `${SECRET}x`), SECRET)).toBe(false);
    expect(verifyWebhookHmac(BODY, undefined, SECRET)).toBe(false);
    expect(verifyWebhookHmac(BODY, '', SECRET)).toBe(false);
  });

  it('signs the bytes as received, accents included', () => {
    const body = JSON.stringify({ name: 'Cantina Città' });

    expect(verifyWebhookHmac(body, sign(body), SECRET)).toBe(true);
  });
});

describe('scopesCovered', () => {
  it('is true when both reads were granted, in any order', () => {
    expect(scopesCovered('read_orders,read_products')).toBe(true);
    expect(scopesCovered(' read_products , read_orders ')).toBe(true);
  });

  it('is false for a narrower grant', () => {
    expect(scopesCovered('read_products')).toBe(false);
    expect(scopesCovered('')).toBe(false);
  });
});
