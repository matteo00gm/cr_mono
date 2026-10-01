import { randomUUID } from 'node:crypto';

import { createApp } from '@catalogorosso/api/app';
import { createBillingEffect } from '@catalogorosso/api/billing-events';
import { createChatPort } from '@catalogorosso/api/chat';
import { createDevBillingPort, type DevBillingPort } from '@catalogorosso/api/dev-billing';
import { createQuotaPort } from '@catalogorosso/api/quota';
import { refusalRecorders } from '@catalogorosso/api/security-events';
import { createStripeEventsPort } from '@catalogorosso/api/stripe-events';
import {
  insertSecurityEvent,
  isTokenRevoked,
  resolveTenantByKeyAndOrigin,
  resolveTenantBySecretKey,
  sessionCutoffAt,
} from '@catalogorosso/db';
import { memoryRateLimiter } from '@catalogorosso/security';
import { generateWidgetTokenKey, loadWidgetTokenKeys } from '@catalogorosso/security/tokens';
import {
  bundleDirectory,
  seedStates,
  startE2eApi,
  startHostPages,
  type E2eApi,
  type HostPages,
  type SeededState,
  type StateSlug,
} from '@catalogorosso/testing';

/**
 * Every billing state in a browser (P3-22): the API with the **real chat
 * port** — its quota gate, its retrieval, its ledger — and a scripted model
 * that counts its calls, so a blocked case can be asserted to have cost nothing.
 *
 * The states are P5-14's fixtures, seeded by the webhook path, each on its own
 * storefront origin; the dev billing port moves one mid-test the same way.
 */

export interface StatesHarness {
  readonly api: E2eApi;
  readonly states: ReadonlyMap<StateSlug, SeededState>;
  readonly pages: ReadonlyMap<StateSlug, HostPages>;
  /** Moves a winery along a billing transition, by the webhook path (P5-14). */
  readonly dev: DevBillingPort;
  /** How many times the scripted model was asked to answer. */
  readonly providerCalls: () => number;
  readonly nextMinute: () => void;
  readonly close: () => Promise<void>;
}

/** What the scripted sommelier says, so a test can read it off the screen. */
export const STATE_REPLY = 'Le consiglio un rosso di struttura.';

export const startStates = async (): Promise<StatesHarness> => {
  const keys = await loadWidgetTokenKeys(
    JSON.stringify({ keys: [await generateWidgetTokenKey('e2e-states')] }),
  );

  let skew = 0;
  let calls = 0;
  const limiter = memoryRateLimiter(() => Date.now() + skew);
  const quota = createQuotaPort();

  const scripted = {
    id: 'e2e-states',
    streamPairing: () => {
      calls += 1;

      // eslint-disable-next-line @typescript-eslint/require-await -- an async generator is the contract
      return (async function* () {
        yield { type: 'text' as const, delta: STATE_REPLY };
      })();
    },
  };

  const chat = createChatPort({
    /* A constant query vector: retrieval runs, against whatever the fixture holds. */
    embeddings: {
      model: 'amazon.titan-embed-text-v2:0',
      dim: 1024,
      embed: (texts) => Promise.resolve(texts.map(() => Array.from({ length: 1024 }, () => 0.1))),
    },
    providers: {
      base: () => scripted,
      strong: () => scripted,
    },
    models: { base: 'amazon.nova-lite-v1:0', strong: 'amazon.nova-2-lite-v1:0' },
    quota,
  });

  const api = await startE2eApi({
    createApp: (dependencies) =>
      createApp(dependencies as Parameters<typeof createApp>[0]) as unknown as {
        fetch: (request: Request) => Promise<Response>;
      },
    dependenciesFor: () => ({
      auth: {
        handler: () => Promise.resolve(new Response('not used', { status: 404 })),
        api: { getSession: () => Promise.resolve(null) },
        stepUpState: () => Promise.resolve(null),
      },
      readMemberships: () => Promise.resolve([]),
      widget: {
        resolve: resolveTenantByKeyAndOrigin,
        limiter,
        /* The month as the config reads it, so a capped winery is told so (P2-10). */
        readUsage: quota.readUsage,
        readPurchased: quota.readPurchased,
        ipSecret: randomUUID(),
        /* `development`, for the cross-origin suite's reason: http and localhost. */
        environment: 'development' as const,
        tokenKeys: () => Promise.resolve(keys),
        isTokenRevoked,
        sessionCutoffAt,
        resolveSecretKey: resolveTenantBySecretKey,
        onRejected: refusalRecorders(insertSecurityEvent).onRejected,
        onTokenRejected: refusalRecorders(insertSecurityEvent).onTokenRejected,
        chat,
      },
    }),
  });

  const dev = createDevBillingPort({
    stripeEvents: createStripeEventsPort({ apply: createBillingEffect({ livemode: false }) }),
  });

  const seeded = await seedStates({ transition: (tenantId, step) => dev.apply(tenantId, step) });
  const states = new Map(seeded.map((state) => [state.slug, state]));
  const pages = new Map<StateSlug, HostPages>();

  for (const state of seeded) {
    pages.set(
      state.slug,
      await startHostPages({
        port: Number(new URL(state.origin).port),
        api: api.origin,
        widgetKey: state.publicKey,
        bundleDir: bundleDirectory(),
      }),
    );
  }

  return {
    api,
    states,
    pages,
    dev,
    providerCalls: () => calls,
    nextMinute: () => {
      skew += 60_000;
    },
    close: async () => {
      for (const page of pages.values()) await page.close();
      await api.close();
    },
  };
};
