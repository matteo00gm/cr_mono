import { createHmac, randomBytes } from 'node:crypto';

import { SHOP_EXPECTED } from '@catalogorosso/core';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { WEBHOOK_PREFIX } from '../src/routes.js';
import type { ShopifyPort } from '../src/shopify.js';
import type { SignatureRejection } from '../src/surfaces/webhooks.js';
import { fakeAuth, oneMembership, signedIn } from './support/auth.js';

/**
 * The Shopify routes (P6-06): who may start an install, what the callback
 * hands the port, and a webhook believed only when signed. What the port does
 * with each is tested in `shopify-port.test.ts` and against Postgres.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
/** Built at runtime, never written down (P0-56). */
const SECRET = `shpss_${randomBytes(16).toString('hex')}`;
const SHOP = 'cantina-rossi.myshopify.com';

const fakePort = () => {
  const port = {
    install: vi.fn<ShopifyPort['install']>(() =>
      Promise.resolve({ url: `https://${SHOP}/admin/oauth/authorize?state=x` }),
    ),
    callback: vi.fn<ShopifyPort['callback']>(() =>
      Promise.resolve('https://app.example/integrazioni?shopify=collegato'),
    ),
    status: vi.fn<ShopifyPort['status']>(() => Promise.resolve({ configured: true, shop: null })),
    uninstalled: vi.fn<ShopifyPort['uninstalled']>(() => Promise.resolve('uninstalled' as const)),
  };

  return port;
};

const dashboard = (role: 'OWNER' | 'EDITOR' = 'OWNER', mfa = true) => {
  const shopify = fakePort();
  const app = createApp({
    auth: signedIn('user_owner', { mfa }),
    readMemberships: oneMembership(TENANT, role),
    shopify,
  });

  return { app, shopify };
};

describe('starting an install', () => {
  const start = (app: ReturnType<typeof dashboard>['app'], body: unknown) =>
    app.request('/v1/dashboard/shopify/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers an owner with the consent URL, for the winery of the membership', async () => {
    const { app, shopify } = dashboard();
    const response = await start(app, { shop: 'cantina-rossi' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: `https://${SHOP}/admin/oauth/authorize?state=x` });
    expect(shopify.install).toHaveBeenCalledWith({
      tenantId: TENANT,
      userId: 'user_owner',
      input: 'cantina-rossi',
    });
  });

  it('is refused to an editor, who may not add a domain', async () => {
    const { app, shopify } = dashboard('EDITOR');

    expect((await start(app, { shop: 'cantina-rossi' })).status).toBe(403);
    expect(shopify.install).not.toHaveBeenCalled();
  });

  it('is refused to an owner without a second factor', async () => {
    const { app, shopify } = dashboard('OWNER', false);

    expect((await start(app, { shop: 'cantina-rossi' })).status).toBe(403);
    expect(shopify.install).not.toHaveBeenCalled();
  });

  it('refuses a body that is not a shop, saying what is wanted', async () => {
    const { app } = dashboard();
    const response = await start(app, { shop: 'x', tenantId: 'another' });

    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain(SHOP_EXPECTED.slice(0, 40));
  });
});

describe('the status', () => {
  it('is every member’s to read', async () => {
    const { app, shopify } = dashboard('EDITOR');
    const response = await app.request('/v1/dashboard/shopify');

    expect(response.status).toBe(200);
    expect(shopify.status).toHaveBeenCalledWith(TENANT);
  });
});

describe('the callback', () => {
  it('hands the port the signed-in user, their second factor and every parameter, and redirects', async () => {
    const { app, shopify } = dashboard();
    const response = await app.request(
      '/v1/dashboard/shopify/callback?code=c&shop=cantina-rossi.myshopify.com&state=s&hmac=h',
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(
      'https://app.example/integrazioni?shopify=collegato',
    );

    const [command] = shopify.callback.mock.calls[0] ?? [];

    expect(command?.userId).toBe('user_owner');
    expect(command?.mfaEnabled).toBe(true);
    expect(Object.fromEntries(command?.params ?? [])).toEqual({
      code: 'c',
      shop: SHOP,
      state: 's',
      hmac: 'h',
    });
  });

  it('needs no active winery: it is the state that names one', async () => {
    /* Two memberships and no header would refuse any tenant route; this one is pre-tenant. */
    const shopify = fakePort();
    const app = createApp({
      auth: signedIn('user_owner'),
      readMemberships: () =>
        Promise.resolve([
          { tenantId: TENANT, role: 'OWNER' as const },
          { tenantId: '22222222-2222-2222-2222-222222222222', role: 'OWNER' as const },
        ]),
      shopify,
    });

    expect((await app.request('/v1/dashboard/shopify/callback?state=s')).status).toBe(302);
  });

  it('is refused without a session, before the port is asked anything', async () => {
    const shopify = fakePort();
    const app = createApp({ auth: fakeAuth(), readMemberships: oneMembership(TENANT), shopify });

    expect((await app.request('/v1/dashboard/shopify/callback?state=s')).status).toBe(401);
    expect(shopify.callback).not.toHaveBeenCalled();
  });
});

describe('a Shopify webhook', () => {
  const PATH = `${WEBHOOK_PREFIX}/shopify`;
  const BODY = JSON.stringify({ id: 1, domain: SHOP });

  /* An options object: `webhooks(undefined)` would quietly get the default secret back. */
  const webhooks = (options: { readonly secret?: string | undefined } = {}) => {
    const secret = 'secret' in options ? options.secret : SECRET;
    const shopify = fakePort();
    const refused: SignatureRejection[] = [];
    const app = createApp({
      auth: fakeAuth(),
      readMemberships: () => Promise.resolve([]),
      shopify,
      ...(secret === undefined ? {} : { shopifySecret: secret }),
      onSignatureRejected: (rejection) => {
        refused.push(rejection);
        return Promise.resolve();
      },
    });

    return { app, shopify, refused };
  };

  const deliver = (
    app: ReturnType<typeof webhooks>['app'],
    {
      topic = 'app/uninstalled',
      body = BODY,
      signature,
    }: { topic?: string; body?: string; signature?: string } = {},
  ) =>
    app.request(PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-topic': topic,
        'x-shopify-shop-domain': SHOP,
        ...(signature === undefined
          ? { 'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(body).digest('base64') }
          : signature === ''
            ? {}
            : { 'x-shopify-hmac-sha256': signature }),
      },
      body,
    });

  it('uninstalls the shop Shopify names when the delivery is signed', async () => {
    const { app, shopify } = webhooks();
    const response = await deliver(app);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: true,
      topic: 'app/uninstalled',
      result: 'uninstalled',
    });
    expect(shopify.uninstalled).toHaveBeenCalledWith(SHOP);
  });

  it('acknowledges a topic it does not handle, and does nothing with it', async () => {
    const { app, shopify } = webhooks();
    const response = await deliver(app, { topic: 'shop/update' });

    expect(await response.json()).toMatchObject({ result: 'ignored' });
    expect(shopify.uninstalled).not.toHaveBeenCalled();
  });

  it('refuses an unsigned delivery, records it, and does nothing', async () => {
    const { app, shopify, refused } = webhooks();

    expect((await deliver(app, { signature: '' })).status).toBe(401);
    expect(refused).toEqual([{ provider: 'shopify', reason: 'missing-headers' }]);
    expect(shopify.uninstalled).not.toHaveBeenCalled();
  });

  it('refuses a body changed after signing', async () => {
    const { app, shopify, refused } = webhooks();
    const signature = createHmac('sha256', SECRET).update(BODY).digest('base64');

    expect((await deliver(app, { body: `${BODY} `, signature })).status).toBe(401);
    expect(refused).toEqual([{ provider: 'shopify', reason: 'no-match' }]);
    expect(shopify.uninstalled).not.toHaveBeenCalled();
  });

  it('is not there at all when no app secret is set', async () => {
    const { app, shopify } = webhooks({ secret: undefined });

    expect((await deliver(app)).status).toBe(404);
    expect(shopify.uninstalled).not.toHaveBeenCalled();
  });
});
