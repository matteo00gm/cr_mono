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
    orderCreated: vi.fn<ShopifyPort['orderCreated']>(() => Promise.resolve('attributed' as const)),
    refundCreated: vi.fn<ShopifyPort['refundCreated']>(() => Promise.resolve('reduced' as const)),
    productUpdated: vi.fn<ShopifyPort['productUpdated']>(() =>
      Promise.resolve({ outcome: 'synced' as const }),
    ),
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
      triggeredAt,
    }: { topic?: string; body?: string; signature?: string; triggeredAt?: string } = {},
  ) =>
    app.request(PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-shopify-topic': topic,
        'x-shopify-shop-domain': SHOP,
        ...(triggeredAt === undefined ? {} : { 'x-shopify-triggered-at': triggeredAt }),
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
    expect(shopify.uninstalled).toHaveBeenCalledWith(SHOP, undefined);
  });

  it('hands over when Shopify says the uninstall happened, not when it arrived (P6-06b)', async () => {
    const { app, shopify } = webhooks();

    await deliver(app, { triggeredAt: '2026-10-04T09:00:27.877041743Z' });

    expect(shopify.uninstalled).toHaveBeenCalledWith(SHOP, new Date('2026-10-04T09:00:27.877Z'));
  });

  it('takes a time it cannot read as no time at all', async () => {
    const { app, shopify } = webhooks();

    await deliver(app, { triggeredAt: 'yesterday, more or less' });

    expect(shopify.uninstalled).toHaveBeenCalledWith(SHOP, undefined);
  });

  it('says so when the news was about an install since replaced', async () => {
    const { app, shopify } = webhooks();

    shopify.uninstalled.mockResolvedValueOnce('stale');

    expect(await (await deliver(app)).json()).toMatchObject({ result: 'stale' });
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

  describe('for an order (P6-07)', () => {
    /* What Shopify sends has a buyer in it; the route's job is to pass it on unread. */
    const ORDER = JSON.stringify({
      id: 5678901234567,
      currency: 'EUR',
      email: 'giulia.bianchi@example.com',
      line_items: [{ id: 1, quantity: 1, price: '42.00' }],
    });

    it('hands the port the shop and the body exactly as it was signed', async () => {
      const { app, shopify } = webhooks();
      const response = await deliver(app, { topic: 'orders/create', body: ORDER });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        received: true,
        topic: 'orders/create',
        result: 'attributed',
      });
      expect(shopify.orderCreated).toHaveBeenCalledWith(SHOP, ORDER);
      expect(shopify.uninstalled).not.toHaveBeenCalled();
    });

    it('refuses an order changed after it was signed, and reads none of it', async () => {
      const { app, shopify, refused } = webhooks();
      const signature = createHmac('sha256', SECRET).update(ORDER).digest('base64');
      const tampered = ORDER.replace('42.00', '4200.00');

      expect(
        (await deliver(app, { topic: 'orders/create', body: tampered, signature })).status,
      ).toBe(401);
      expect(refused).toEqual([{ provider: 'shopify', reason: 'no-match' }]);
      expect(shopify.orderCreated).not.toHaveBeenCalled();
    });

    it('refuses an unsigned order', async () => {
      const { app, shopify } = webhooks();

      expect(
        (await deliver(app, { topic: 'orders/create', body: ORDER, signature: '' })).status,
      ).toBe(401);
      expect(shopify.orderCreated).not.toHaveBeenCalled();
    });

    it.each(['nothing', 'unknown', 'unreadable'] as const)(
      'acknowledges an order that came to %s, so Shopify does not send it again',
      async (outcome) => {
        const { app, shopify } = webhooks();

        shopify.orderCreated.mockResolvedValueOnce(outcome);

        const response = await deliver(app, { topic: 'orders/create', body: ORDER });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ result: outcome });
      },
    );

    it('answers with nothing of the order in it', async () => {
      const { app } = webhooks();
      const answer = await (await deliver(app, { topic: 'orders/create', body: ORDER })).text();

      expect(answer).not.toContain('giulia');
      expect(answer).not.toContain('5678901234567');
    });

    it('is not what any other topic does', async () => {
      const { app, shopify } = webhooks();

      await deliver(app, { topic: 'orders/updated', body: ORDER });
      await deliver(app, { topic: 'app/uninstalled', body: ORDER });
      await deliver(app, { topic: 'refunds/create', body: ORDER });

      expect(shopify.orderCreated).not.toHaveBeenCalled();
    });
  });

  describe('for a refund (P6-08)', () => {
    const REFUND = JSON.stringify({
      id: 890123456789,
      order_id: 5678901234567,
      note: 'Bottiglia rotta — Giulia Bianchi',
      refund_line_items: [{ id: 1, line_item_id: 2, quantity: 1 }],
    });

    it('hands the port the shop and the body exactly as it was signed', async () => {
      const { app, shopify } = webhooks();
      const response = await deliver(app, { topic: 'refunds/create', body: REFUND });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        received: true,
        topic: 'refunds/create',
        result: 'reduced',
      });
      expect(shopify.refundCreated).toHaveBeenCalledWith(SHOP, REFUND);
      expect(shopify.orderCreated).not.toHaveBeenCalled();
    });

    it('refuses a refund changed after it was signed, and reads none of it', async () => {
      const { app, shopify, refused } = webhooks();
      const signature = createHmac('sha256', SECRET).update(REFUND).digest('base64');
      const tampered = REFUND.replace('"quantity":1', '"quantity":9');

      expect(
        (await deliver(app, { topic: 'refunds/create', body: tampered, signature })).status,
      ).toBe(401);
      expect(refused).toEqual([{ provider: 'shopify', reason: 'no-match' }]);
      expect(shopify.refundCreated).not.toHaveBeenCalled();
    });

    it.each(['nothing', 'unknown', 'unreadable'] as const)(
      'acknowledges a refund that came to %s',
      async (outcome) => {
        const { app, shopify } = webhooks();

        shopify.refundCreated.mockResolvedValueOnce(outcome);

        const response = await deliver(app, { topic: 'refunds/create', body: REFUND });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ result: outcome });
      },
    );

    it('answers with nothing of the refund in it', async () => {
      const { app } = webhooks();
      const answer = await (await deliver(app, { topic: 'refunds/create', body: REFUND })).text();

      expect(answer).not.toContain('Giulia');
      expect(answer).not.toContain('5678901234567');
    });

    it('is not what an order does', async () => {
      const { app, shopify } = webhooks();

      await deliver(app, { topic: 'orders/create', body: REFUND });

      expect(shopify.refundCreated).not.toHaveBeenCalled();
    });
  });

  describe('for a product update (P6-11)', () => {
    const PRODUCT = JSON.stringify({
      id: 7890123456789,
      updated_at: '2026-10-05T10:15:30+02:00',
      variants: [{ id: 45123456789, inventory_quantity: 0, inventory_management: 'shopify' }],
    });

    it('hands the port the shop and the body exactly as it was signed', async () => {
      const { app, shopify } = webhooks();
      const response = await deliver(app, { topic: 'products/update', body: PRODUCT });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        received: true,
        topic: 'products/update',
        result: 'synced',
      });
      expect(shopify.productUpdated).toHaveBeenCalledWith(SHOP, PRODUCT);
      expect(shopify.orderCreated).not.toHaveBeenCalled();
    });

    it('refuses a product update changed after it was signed', async () => {
      /* "Sold out" is a claim about a seller's shop: only Shopify may make it. */
      const { app, shopify, refused } = webhooks();
      const signature = createHmac('sha256', SECRET).update(PRODUCT).digest('base64');
      const tampered = PRODUCT.replace('"inventory_quantity":0', '"inventory_quantity":99');

      expect(
        (await deliver(app, { topic: 'products/update', body: tampered, signature })).status,
      ).toBe(401);
      expect(refused).toEqual([{ provider: 'shopify', reason: 'no-match' }]);
      expect(shopify.productUpdated).not.toHaveBeenCalled();
    });

    it.each(['nothing', 'unknown', 'unreadable'] as const)(
      'acknowledges one that came to %s',
      async (outcome) => {
        const { app, shopify } = webhooks();

        shopify.productUpdated.mockResolvedValueOnce({ outcome });

        const response = await deliver(app, { topic: 'products/update', body: PRODUCT });

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ result: outcome });
      },
    );

    it('asks the shop to send it again when it has sent too many, and says when', async () => {
      /*
       * The one delivery that is not acknowledged. Shopify redelivers what it
       * is refused; an acknowledged drop would lose the latest stock, which is
       * the only one that matters.
       */
      const { app, shopify } = webhooks();

      shopify.productUpdated.mockResolvedValueOnce({ outcome: 'throttled', retryAfterSec: 17 });

      const response = await deliver(app, { topic: 'products/update', body: PRODUCT });

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('17');
      expect(await response.json()).toMatchObject({ error: { code: 'rate_limited' } });
    });

    it('is not what any other products topic does', async () => {
      const { app, shopify } = webhooks();

      await deliver(app, { topic: 'products/create', body: PRODUCT });
      await deliver(app, { topic: 'products/delete', body: PRODUCT });

      expect(shopify.productUpdated).not.toHaveBeenCalled();
    });
  });
});
