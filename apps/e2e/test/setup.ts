import { randomBytes, randomUUID } from 'node:crypto';

import { createApp } from '@catalogorosso/api/app';
import type { ChatRequest } from '@catalogorosso/api/chat';
import { refusalRecorders } from '@catalogorosso/api/security-events';
import { createShopifyPort } from '@catalogorosso/api/shopify';
import { memoryShopifyTokens } from '@catalogorosso/api/shopify-tokens';
import {
  insertSecurityEvent,
  isTokenRevoked,
  recordTurn,
  resolveTenantByKeyAndOrigin,
  resolveTenantBySecretKey,
  sessionCutoffAt,
  withTenant,
} from '@catalogorosso/db';
import { memoryRateLimiter } from '@catalogorosso/security';
import { hashSecretKey, newSecretKey } from '@catalogorosso/security/api-keys';
import { generateWidgetTokenKey, loadWidgetTokenKeys } from '@catalogorosso/security/tokens';
import {
  bundleDirectory,
  startE2eApi,
  startHostPages,
  UNVERIFIED_PORT,
  VERIFIED_PORT,
  WIDGET_KEY,
  type E2eApi,
  type HostPages,
} from '@catalogorosso/testing';

/**
 * Everything the browser suite needs, brought up once (P3-18).
 *
 * **The API is real and the model is not.** P1-47 forbids paid provider calls
 * without agreed spend, and nothing this suite asserts is about model quality:
 * it is about a browser refusing a cross-origin request, a session minting, a
 * stream arriving in pieces, and a cart line carrying the session property.
 * Every one of those is the real code path.
 */

export interface Harness {
  readonly api: E2eApi;
  /** The winery's secret key, as its server holds it (P4-10). Generated per run. */
  readonly secretKey: string;
  readonly verified: HostPages;
  readonly unverified: HostPages;
  /**
   * Moves the rate limiter one window on, as if a minute had passed.
   *
   * **Only the limiter's clock moves.** A token's expiry, a session's cutoff and
   * everything else keep real time, so this cannot make anything valid that is
   * not. It exists for a spec that asks more per minute than a trial winery is
   * allowed (`tenantPerMinute.none`, P2-02) and is not *about* that limit.
   */
  readonly nextMinute: () => void;
  /** The seeded winery's Shopify store, when the harness was started with one (P6-08). */
  readonly shopify: ShopifyFixture | undefined;
  readonly close: () => Promise<void>;
}

/** A connected store, and what its webhooks are signed with. */
export interface ShopifyFixture {
  readonly shop: string;
  /** Generated per run, never written down (P0-56). */
  readonly secret: string;
}

export interface StartOptions {
  /**
   * Connects a Shopify store to the seeded winery (P6-08): the port, the
   * secret a webhook is signed with, and an installation row for the shop.
   *
   * It also makes the scripted answer **record its turn through the real
   * statement**, as the chat port does when a stream ends. The suite scripts
   * the model and nothing beneath it, and a conversation is beneath it: an
   * order can only be traced back to one that exists.
   */
  readonly shopify?: boolean | undefined;
}

/** The store the attribution spec's winery connected. */
export const E2E_SHOP = 'cantina-e2e.myshopify.com';

/** What the scripted sommelier says, so the suite can read it off the screen. */
export const SCRIPTED_REPLY = 'Con una bistecca le consiglio un Barolo Bussia.';
export const SCRIPTED_REASON = 'Tannino deciso, giusto per la carne alla griglia.';

export const start = async ({ shopify = false }: StartOptions = {}): Promise<Harness> => {
  /* The same shape the secret carries in a deployment (P2-11): `{ keys: [...] }`,
   * newest first. Generated per run, so nothing key-shaped is written down. */
  const keys = await loadWidgetTokenKeys(
    JSON.stringify({ keys: [await generateWidgetTokenKey('e2e')] }),
  );

  /* Generated per run, never written down (P0-56). Only its hash reaches the database. */
  const secretKey = newSecretKey();

  let skew = 0;
  const limiter = memoryRateLimiter(() => Date.now() + skew);

  const store: ShopifyFixture | undefined = shopify
    ? { shop: E2E_SHOP, secret: ['shpss', 'e2e', randomBytes(16).toString('hex')].join('_') }
    : undefined;

  const api = await startE2eApi({
    secretKeyHash: hashSecretKey(secretKey),
    createApp: (dependencies) =>
      createApp(dependencies as Parameters<typeof createApp>[0]) as unknown as {
        fetch: (request: Request) => Promise<Response>;
      },

    dependenciesFor: ({ productId }) => ({
      auth: {
        handler: () => Promise.resolve(new Response('not used', { status: 404 })),
        api: {
          getSession: () => Promise.resolve(null),
        },
        stepUpState: () => Promise.resolve(null),
      },
      readMemberships: () => Promise.resolve([]),

      /* Real (P6-06 to P6-08): the webhook route, its signature check and the port behind it. */
      ...(store === undefined
        ? {}
        : {
            shopifySecret: store.secret,
            shopify: createShopifyPort({
              config: { clientId: 'e2e-client', clientSecret: store.secret },
              redirectUri: 'http://localhost:4000/v1/dashboard/shopify/callback',
              returnTo: 'http://localhost:4000/integrazioni',
              tokens: memoryShopifyTokens(),
              readMemberships: () => Promise.resolve([]),
            }),
          }),

      widget: {
        /* Real: this is the thing under test. */
        resolve: resolveTenantByKeyAndOrigin,
        limiter,
        readUsage: () => Promise.resolve(0),
        ipSecret: randomUUID(),
        /*
         * **`development`, and the reason is load-bearing.** P2-05's production
         * rule refuses `http:` and `localhost` outright, so a production-mode
         * harness would refuse *both* ports — and the `:4002` case would pass
         * for the wrong reason, proving the scheme check rather than the
         * verified-origin set. Development relaxes normalisation only; whether
         * an origin is in `tenant_domains` is decided identically either way,
         * which is the thing under test.
         */
        environment: 'development' as const,
        tokenKeys: () => Promise.resolve(keys),
        isTokenRevoked,
        /*
         * The real reader (P4-06), not a stub. A verifier that cannot ask
         * whether an origin's sessions were ended accepts them, so the surface
         * refuses every token when this is absent — which is how the first
         * version of this row turned the whole browser suite red, correctly,
         * and where a hand-rolled stub would have hidden it.
         */
        sessionCutoffAt,
        /* Real (P4-10): the seventh RLS scope, under the role a deployment runs as. */
        resolveSecretKey: resolveTenantBySecretKey,
        /*
         * The real recorder (P2-16), so the row a test reads back is the row a
         * deployment would write — including its type, which is the part a
         * hand-rolled stub would get subtly wrong.
         */
        onRejected: refusalRecorders(insertSecurityEvent).onRejected,
        onTokenRejected: refusalRecorders(insertSecurityEvent).onTokenRejected,

        /*
         * The one scripted piece. It yields text in two chunks so a test can
         * tell a stream from a single write, then a card built from the seeded
         * product — which is what §1.5 says a card is: our row, not the model's.
         */
        chat: {
          answer: async function* (request: ChatRequest) {
            /*
             * The turn, written by the statement the real port writes it with
             * (P2-30), before the cards go out — so by the time a shopper can
             * press *Aggiungi al carrello* the conversation is there for the
             * widget's own events to find.
             */
            if (store !== undefined) {
              await withTenant(request.tenant.tenantId, (tx) =>
                recordTurn(tx, {
                  sessionId: request.sessionId,
                  origin: request.origin,
                  visitorHash: null,
                  locale: 'it',
                  question: request.message,
                  reply: SCRIPTED_REPLY,
                  retrievedProductIds: [productId],
                  recommendedProductIds: [productId],
                  zeroResultKind: null,
                  model: null,
                  inputTokens: null,
                  outputTokens: null,
                  latencyMs: null,
                }),
              );
            }

            yield { type: 'text' as const, delta: SCRIPTED_REPLY.slice(0, 20) };
            yield { type: 'text' as const, delta: SCRIPTED_REPLY.slice(20) };
            yield {
              type: 'recommendations' as const,
              items: [
                {
                  productId,
                  reason: SCRIPTED_REASON,
                  confidence: 0.9,
                  product: {
                    name: 'Barolo Bussia',
                    producer: 'Cantina Rossi',
                    vintage: 2016,
                    priceCents: 4200,
                    currency: 'EUR',
                    imageUrl: null,
                    productUrl: null,
                    stockStatus: 'IN_STOCK' as const,
                    variantId: '45123456789',
                  },
                },
              ],
            };
          },
        },
      },
    }),
  });

  const pages = {
    api: api.origin,
    widgetKey: WIDGET_KEY,
    bundleDir: bundleDirectory(),
  };

  const verified = await startHostPages({ port: VERIFIED_PORT, ...pages });
  const unverified = await startHostPages({ port: UNVERIFIED_PORT, ...pages });

  if (store !== undefined) await api.connectShop(store.shop);

  return {
    api,
    secretKey,
    verified,
    unverified,
    nextMinute: () => {
      skew += 60_000;
    },
    shopify: store,
    close: async () => {
      await verified.close();
      await unverified.close();
      await api.close();
    },
  };
};
