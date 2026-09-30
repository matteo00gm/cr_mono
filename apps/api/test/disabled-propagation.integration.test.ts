import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';

import { widgetSessionResponse, type WidgetChatEvent } from '@catalogorosso/api-client';
import {
  isTokenRevoked,
  resolveTenantByKeyAndOrigin,
  resolveTenantBySecretKey,
  sessionCutoffAt,
} from '@catalogorosso/db';
import { memoryRateLimiter } from '@catalogorosso/security';
import { generateWidgetTokenKey, loadWidgetTokenKeys } from '@catalogorosso/security/tokens';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { createBillingEffect } from '../src/billing-events.js';
import type { ChatPort } from '../src/chat.js';
import { logger } from '../src/middleware/logger.js';
import { createStripeEventsPort } from '../src/stripe-events.js';
import { fakeAuth } from './support/auth.js';

/**
 * DISABLED propagation, split (P5-07, §5.7).
 *
 * **The subtlest guarantee in §5.7, and the one caching would quietly break.**
 * A winery Stripe switches off loses its widget *at once* on every path that
 * spends money or hands out a credential — the session mint, and a chat on a
 * token minted before the switch — with **zero** model calls. The config is
 * the exception, on purpose: it is edge-cached for sixty seconds (P2-10), so a
 * shopper may see an enabled launcher for up to a minute and then be refused
 * the moment they ask anything. That lag is documented here as intended, and
 * the origin itself already answers disabled.
 *
 * Everything is real behind the edge: the signed Stripe endpoint, the state
 * machine, the widget's resolution against Postgres as `app_rw`, the token
 * keyset and the gate. Only the model is counted rather than called (P1-47).
 */

const SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const ORIGIN = 'https://www.cantina-propagation.example';

let harness: TestDatabase | undefined;
let app: ReturnType<typeof createApp>;
let modelCalls = 0;

const admin = () => {
  if (harness === undefined) throw new Error('no database');
  return harness.adminDb;
};

/** The model, counted: every answer it would have given is a call we would have paid for. */
const chat: ChatPort = {
  answer: () => {
    modelCalls += 1;

    return (async function* (): AsyncGenerator<WidgetChatEvent> {
      yield await Promise.resolve<WidgetChatEvent>({ type: 'text', delta: 'Un Barolo.' });
    })();
  },
};

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');

  const keys = await loadWidgetTokenKeys(
    JSON.stringify({ keys: [await generateWidgetTokenKey('p5-07')] }),
  );

  app = createApp({
    auth: fakeAuth(),
    readMemberships: () => Promise.resolve([]),
    stripeWebhookSecret: SECRET,
    stripeEvents: createStripeEventsPort({ apply: createBillingEffect({ livemode: false }) }),
    widget: {
      resolve: resolveTenantByKeyAndOrigin,
      limiter: memoryRateLimiter(),
      readUsage: () => Promise.resolve(0),
      ipSecret: randomUUID(),
      environment: 'production',
      tokenKeys: () => Promise.resolve(keys),
      isTokenRevoked,
      sessionCutoffAt,
      resolveSecretKey: resolveTenantBySecretKey,
      chat,
    },
  });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});

/** A paying winery with a verified storefront and a key, as a widget finds it. */
const paying = async () => {
  const tenantId = randomUUID();
  const key = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');
  const customer = `cus_${randomUUID().slice(0, 8)}`;
  const subscription = `sub_${randomUUID().slice(0, 8)}`;
  const origin = ORIGIN.replace('propagation', `p${tenantId.slice(0, 8)}`);
  const registrable = new URL(origin).hostname.replace(/^www\./u, '');

  await admin().execute(sql`
    INSERT INTO tenants (id, name, slug, status, plan, stripe_customer_id, stripe_subscription_id)
    VALUES (${tenantId}, 'Cantina', ${`dp-${tenantId}`}, 'ACTIVE', 'CANTINA', ${customer}, ${subscription})
  `);
  await admin().execute(sql`
    INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status, verified_at)
    VALUES (${tenantId}, ${origin}, ${registrable}, 'VERIFIED', now())
  `);
  await admin().execute(sql`
    INSERT INTO widget_keys (tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4)
    VALUES (${tenantId}, ${key}, md5(random()::text), 'sk_test_', 'abcd')
  `);

  return { tenantId, key, customer, subscription, origin };
};

type Winery = Awaited<ReturnType<typeof paying>>;

const widget = (
  winery: Winery,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
) =>
  app.request(`/v1/widget/${path}?key=${encodeURIComponent(winery.key)}`, {
    method: init.method ?? 'GET',
    headers: {
      origin: winery.origin,
      'x-forwarded-for': '203.0.113.7',
      'content-type': 'application/json',
      ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

/** The two ways Stripe switches a widget off: the subscription ends, or a payment fails. */
const SWITCHES_OFF = {
  'customer.subscription.deleted': (winery: Winery) => ({
    id: winery.subscription,
    object: 'subscription',
    customer: winery.customer,
    status: 'canceled',
    metadata: { tenant_id: winery.tenantId },
    items: { data: [{ price: { lookup_key: 'cantina_monthly_eur' } }] },
  }),
  'invoice.payment_failed': (winery: Winery) => ({
    object: 'invoice',
    customer: winery.customer,
    parent: {
      subscription_details: {
        subscription: winery.subscription,
        metadata: { tenant_id: winery.tenantId },
      },
    },
  }),
} as const;

/** Stripe switches the widget off: the signed event, through the real endpoint. */
const stripeSwitchesOff = async (winery: Winery, type: keyof typeof SWITCHES_OFF) => {
  const body = JSON.stringify({
    id: `evt_${randomUUID().replaceAll('-', '')}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: SWITCHES_OFF[type](winery) },
  });
  const t = String(Math.floor(Date.now() / 1000));
  const v1 = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');

  const response = await app.request('/v1/webhooks/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` },
    body,
  });

  expect(await response.json()).toMatchObject({ applied: true });
};

describe.each([
  ['DISABLED', 'customer.subscription.deleted'],
  ['PAST_DUE', 'invoice.payment_failed'],
] as const)('%s propagation', (_status, switchOff) => {
  it('disabled tenant loses access immediately even while config is still cached', async () => {
    const winery = await paying();
    modelCalls = 0;

    /* Before: served, with a session and a conversation under way. */
    const minted = await widget(winery, 'session', { method: 'POST', body: {} });

    expect(minted.status).toBe(200);

    const { token } = widgetSessionResponse.parse(await minted.json());
    const before = await widget(winery, 'chat', {
      method: 'POST',
      token,
      body: { message: 'Un rosso' },
    });

    expect(before.status).toBe(200);
    await before.text();
    expect(modelCalls).toBe(1);

    await stripeSwitchesOff(winery, switchOff);

    /* A new session: refused at once. */
    const mint = await widget(winery, 'session', { method: 'POST', body: {} });

    expect(mint.status).toBe(403);
    expect(await mint.json()).toMatchObject({ error: { code: 'unavailable' } });

    /* The token minted before the switch: refused at once, mid-conversation. */
    const after = await widget(winery, 'chat', {
      method: 'POST',
      token,
      body: { message: 'E un bianco?' },
    });

    expect(after.status).toBe(403);
    expect(await after.json()).toMatchObject({ error: { code: 'unavailable' } });

    /* And the model was never asked again: the refusal cost nothing. */
    expect(modelCalls).toBe(1);

    /*
     * The config is the documented exception. It is cacheable for sixty
     * seconds (P2-10), so the edge may keep showing the launcher enabled for
     * up to a minute — and every path that spends anything is already closed
     * behind it. The origin itself answers disabled from the first request.
     */
    const config = await widget(winery, 'config');

    expect(config.headers.get('cache-control')).toMatch(/max-age=60\b/u);
    expect(await config.json()).toMatchObject({ status: 'DISABLED' });
  });
});
