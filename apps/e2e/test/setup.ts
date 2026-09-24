import { randomUUID } from 'node:crypto';

import { createApp } from '@catalogorosso/api/app';
import { refusalRecorders } from '@catalogorosso/api/security-events';
import {
  insertSecurityEvent,
  isTokenRevoked,
  resolveTenantByKeyAndOrigin,
} from '@catalogorosso/db';
import { memoryRateLimiter } from '@catalogorosso/security';
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
  readonly verified: HostPages;
  readonly unverified: HostPages;
  readonly close: () => Promise<void>;
}

/** What the scripted sommelier says, so the suite can read it off the screen. */
export const SCRIPTED_REPLY = 'Con una bistecca le consiglio un Barolo Bussia.';
export const SCRIPTED_REASON = 'Tannino deciso, giusto per la carne alla griglia.';

export const start = async (): Promise<Harness> => {
  /* The same shape the secret carries in a deployment (P2-11): `{ keys: [...] }`,
   * newest first. Generated per run, so nothing key-shaped is written down. */
  const keys = await loadWidgetTokenKeys(
    JSON.stringify({ keys: [await generateWidgetTokenKey('e2e')] }),
  );

  const api = await startE2eApi({
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
      },
      readMemberships: () => Promise.resolve([]),

      widget: {
        /* Real: this is the thing under test. */
        resolve: resolveTenantByKeyAndOrigin,
        limiter: memoryRateLimiter(),
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
          // eslint-disable-next-line @typescript-eslint/require-await -- an async generator is the contract
          answer: async function* () {
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

  return {
    api,
    verified,
    unverified,
    close: async () => {
      await verified.close();
      await unverified.close();
      await api.close();
    },
  };
};
