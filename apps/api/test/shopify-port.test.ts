import { createHmac } from 'node:crypto';

import { ConflictError, InvalidRequestError, SHOP_EXPECTED, stateHash } from '@catalogorosso/core';
import type { SpentState } from '@catalogorosso/db';
import type { GuardedResponse } from '@catalogorosso/security/net';
import { describe, expect, it, vi } from 'vitest';

import {
  createShopifyPort,
  exchangeOverGuardedFetch,
  unconfiguredShopify,
  type ShopifyDeps,
} from '../src/shopify.js';
import { memoryShopifyTokens } from '../src/shopify-tokens.js';

/**
 * The Shopify install, without a database (P6-06): every refusal the
 * callback makes before it writes anything, and the exchange's own rules.
 * The install that completes is in `shopify.integration.test.ts`.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = 'user_owner';
const SHOP = 'cantina-rossi.myshopify.com';
/** Built at runtime, never written down (P0-56). */
const SECRET = ['shpss', 'unit', 'b'.repeat(24)].join('_');
const CONFIG = { clientId: 'client-1', clientSecret: SECRET };
const NONCE = 'nonce-from-the-browser';

const signed = (params: Record<string, string>, secret = SECRET): URLSearchParams => {
  const message = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name] ?? ''}`)
    .join('&');

  return new URLSearchParams({
    ...params,
    hmac: createHmac('sha256', secret).update(message).digest('hex'),
  });
};

const CALLBACK = { code: 'code-1', shop: SHOP, state: NONCE, timestamp: '1790000000' };

const portWith = (overrides: Partial<ShopifyDeps> = {}) => {
  const exchange = vi.fn<NonNullable<ShopifyDeps['exchange']>>(() =>
    Promise.resolve({ accessToken: 'token-1', scope: 'read_products,read_orders' }),
  );
  const spendState = vi.fn<NonNullable<ShopifyDeps['spendState']>>(
    (): Promise<SpentState | undefined> =>
      Promise.resolve({ tenantId: TENANT, shop: SHOP, expired: false }),
  );
  const port = createShopifyPort({
    config: CONFIG,
    redirectUri: 'https://app.example/v1/dashboard/shopify/callback',
    returnTo: 'https://app.example/integrazioni',
    tokens: memoryShopifyTokens(),
    readMemberships: () => Promise.resolve([{ tenantId: TENANT, role: 'OWNER' }]),
    exchange,
    spendState,
    ...overrides,
  });

  return { port, exchange, spendState };
};

const reasonOf = (location: string): string | null => new URL(location).searchParams.get('motivo');

const callback = (
  port: ReturnType<typeof portWith>['port'],
  params = signed(CALLBACK),
  mfa = true,
) => port.callback({ userId: USER, mfaEnabled: mfa, params });

describe('the callback refuses', () => {
  it('when Shopify is not set up here', async () => {
    const { port } = portWith({ config: undefined });

    expect(reasonOf(await callback(port))).toBe('configurazione');
  });

  it('a callback Shopify did not sign, before spending anything', async () => {
    const { port, spendState, exchange } = portWith();

    expect(reasonOf(await callback(port, signed(CALLBACK, `${SECRET}x`)))).toBe('firma');
    expect(spendState).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });

  it('a signed callback naming something that is not a shop', async () => {
    const { port } = portWith();

    expect(reasonOf(await callback(port, signed({ ...CALLBACK, shop: 'evil.example' })))).toBe(
      'negozio',
    );
  });

  it('a callback with no state or no code', async () => {
    const { port } = portWith();
    const without = (name: string) =>
      Object.fromEntries(Object.entries(CALLBACK).filter(([held]) => held !== name));
    const withoutState = without('state');
    const withoutCode = without('code');

    expect(reasonOf(await callback(port, signed(withoutState)))).toBe('stato');
    expect(reasonOf(await callback(port, signed(withoutCode)))).toBe('stato');
  });

  it('a state this member does not hold — never started, spent, or another’s', async () => {
    const { port, spendState, exchange } = portWith({
      spendState: () => Promise.resolve(undefined),
    });

    expect(reasonOf(await callback(port))).toBe('stato');
    expect(exchange).not.toHaveBeenCalled();
    void spendState;
  });

  it('spends the state by the hash of what the browser carried', async () => {
    /* Stopped at the exchange, so nothing here needs a database. */
    const { port, spendState } = portWith({ exchange: () => Promise.reject(new Error('stop')) });

    await callback(port);

    expect(spendState).toHaveBeenCalledWith(USER, stateHash(NONCE), expect.any(Date));
  });

  it('a lapsed state', async () => {
    const { port, exchange } = portWith({
      spendState: () => Promise.resolve({ tenantId: TENANT, shop: SHOP, expired: true }),
    });

    expect(reasonOf(await callback(port))).toBe('scaduto');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('a state started for another shop than the one Shopify sent back', async () => {
    const { port, exchange } = portWith({
      spendState: () =>
        Promise.resolve({ tenantId: TENANT, shop: 'altra.myshopify.com', expired: false }),
    });

    expect(reasonOf(await callback(port))).toBe('negozio');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('a member who is no longer in the winery', async () => {
    const { port, exchange } = portWith({ readMemberships: () => Promise.resolve([]) });

    expect(reasonOf(await callback(port))).toBe('permessi');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('a member who may not add a domain', async () => {
    const { port } = portWith({
      readMemberships: () => Promise.resolve([{ tenantId: TENANT, role: 'EDITOR' }]),
    });

    expect(reasonOf(await callback(port))).toBe('permessi');
  });

  it('an owner without a second factor, as the route itself would', async () => {
    const { port, exchange } = portWith();

    expect(reasonOf(await callback(port, signed(CALLBACK), false))).toBe('verifica');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('an exchange that fails, saying only that it did', async () => {
    const { port } = portWith({ exchange: () => Promise.reject(new Error('shop said 400')) });

    const location = await callback(port);

    expect(reasonOf(location)).toBe('scambio');
    expect(location).not.toContain('400');
  });

  it('a grant narrower than the app asked for', async () => {
    const { port } = portWith({
      exchange: () => Promise.resolve({ accessToken: 't', scope: 'read_products' }),
    });

    expect(reasonOf(await callback(port))).toBe('ambiti');
  });

  it('back to the dashboard every time, never to anywhere the callback named', async () => {
    const { port } = portWith();
    const location = await callback(port, signed({ ...CALLBACK, shop: 'evil.example' }));

    expect(new URL(location).origin).toBe('https://app.example');
    expect(new URL(location).pathname).toBe('/integrazioni');
  });
});

describe('starting an install', () => {
  it('refuses when Shopify is not set up here, as a conflict the owner is told', async () => {
    const { port } = portWith({ config: undefined });

    await expect(
      port.install({ tenantId: TENANT, userId: USER, input: SHOP }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a shop name that is not one, saying what is wanted', async () => {
    const { port } = portWith();

    await expect(
      port.install({ tenantId: TENANT, userId: USER, input: 'www.cantina.example' }),
    ).rejects.toThrow(new InvalidRequestError(SHOP_EXPECTED));
  });
});

describe('the status and the uninstall, with nothing set up', () => {
  it('says Shopify is not set up', async () => {
    const { port } = portWith({ config: undefined });

    expect(await port.status(TENANT)).toEqual({ configured: false, shop: null });
    expect(await unconfiguredShopify.status(TENANT)).toEqual({ configured: false, shop: null });
  });

  it('ignores an uninstall for something that is not a shop, or a shop nobody holds', async () => {
    const resolveShop = vi.fn(() => Promise.resolve(undefined));
    const { port } = portWith({ resolveShop });

    expect(await port.uninstalled('not a shop')).toBe('unknown');
    expect(resolveShop).not.toHaveBeenCalled();
    expect(await port.uninstalled(SHOP)).toBe('unknown');
    expect(await unconfiguredShopify.uninstalled(SHOP)).toBe('unknown');
  });

  it('refuses everything else loudly when no port was wired', async () => {
    await expect(
      unconfiguredShopify.install({ tenantId: TENANT, userId: USER, input: SHOP }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      unconfiguredShopify.callback({
        userId: USER,
        mfaEnabled: true,
        params: new URLSearchParams(),
      }),
    ).rejects.toThrow(/No Shopify port/u);
  });
});

describe('the code-for-token exchange', () => {
  const answering = (status: number, body: string) =>
    vi.fn<(url: string, options?: unknown) => Promise<GuardedResponse>>(() =>
      Promise.resolve({ status, body }),
    );

  it('posts our credentials and the code to the shop, through guardedFetch', async () => {
    const fetch_ = answering(200, JSON.stringify({ access_token: 'tok', scope: 'read_products' }));

    expect(await exchangeOverGuardedFetch(CONFIG, fetch_ as never)(SHOP, 'code-1')).toEqual({
      accessToken: 'tok',
      scope: 'read_products',
    });

    const [url, options] = fetch_.mock.calls[0] ?? [];

    expect(url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(options).toMatchObject({ method: 'POST', maxBytes: 4096 });
    expect(JSON.parse((options as { json: string }).json)).toEqual({
      client_id: 'client-1',
      client_secret: SECRET,
      code: 'code-1',
    });
  });

  it('never sends our secret to something that is not a shop', async () => {
    const fetch_ = answering(200, '{}');

    await expect(
      exchangeOverGuardedFetch(CONFIG, fetch_ as never)('evil.example', 'code-1'),
    ).rejects.toThrow();
    expect(fetch_).not.toHaveBeenCalled();
  });

  it('fails on an answer that is not a 200, or not a token', async () => {
    await expect(
      exchangeOverGuardedFetch(CONFIG, answering(400, '{}') as never)(SHOP, 'c'),
    ).rejects.toThrow(/400/u);
    await expect(
      exchangeOverGuardedFetch(CONFIG, answering(200, '{"scope":"x"}') as never)(SHOP, 'c'),
    ).rejects.toThrow();
  });
});
