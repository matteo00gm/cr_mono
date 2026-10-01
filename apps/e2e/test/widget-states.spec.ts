import { expect, test, type Page } from '@playwright/test';

import type { StateSlug } from '@catalogorosso/testing';

import { STATE_REPLY, startStates, type StatesHarness } from './states-setup.js';

/**
 * What a shopper sees for every billing state (P3-22, §1.3, §5.2b).
 *
 * Under no grace, every failure mode here is customer-visible: a shopper on a
 * live storefront meets a dead chat, and the difference between a calm "not
 * available" and an error with a retry button is the difference between a
 * shrug and a support ticket. Each winery is a P5-14 fixture on its own
 * storefront, put in its state by the webhook path; the model is scripted and
 * counted, so a blocked case can be shown to have cost nothing.
 */

const DISABLED = 'Il sommelier AI non è attivo al momento.';
const QUOTA = 'Il sommelier si riposa. Torna presto!';

/*
 * An Italian shopper, as these storefronts' would be: the widget writes its own
 * words in the visitor's language and the welcome in the winery's, and these
 * assertions read the Italian of both.
 */
test.use({ locale: 'it-IT' });

let harness: StatesHarness;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  harness = await startStates();
});

test.afterAll(async () => {
  await harness.close();
});

test.beforeEach(() => {
  /* A fresh limiter window: none of these is about rate limits. */
  harness.nextMinute();
});

const launcher = (page: Page) => page.locator('sommelier-widget').locator('button').first();
const panel = (page: Page) => page.locator('sommelier-widget').locator('.panel');

const visit = async (page: Page, slug: StateSlug): Promise<void> => {
  const state = harness.states.get(slug);
  if (state === undefined) throw new Error(`no fixture ${slug}`);
  await page.goto(state.origin);
};

const tenantOf = (slug: StateSlug): string => {
  const state = harness.states.get(slug);
  if (state === undefined) throw new Error(`no fixture ${slug}`);
  return state.tenantId;
};

const ask = async (page: Page, text: string): Promise<void> => {
  const composer = panel(page).locator('.composer-input');

  await composer.fill(text);
  await composer.press('Enter');
};

test.describe('a winery that is served', () => {
  for (const slug of ['trialing-fresh', 'active-healthy'] as const) {
    test(`${slug} answers`, async ({ page }) => {
      await visit(page, slug);
      await launcher(page).click();
      await ask(page, 'Cosa mi consigli con una bistecca?');

      await expect(panel(page).locator('.chat-log')).toContainText(STATE_REPLY);
    });
  }
});

test.describe('capped is not blocked', () => {
  for (const slug of ['trialing-capped', 'active-capped'] as const) {
    test(`${slug} says come back soon, and costs nothing`, async ({ page }) => {
      const before = harness.providerCalls();

      await visit(page, slug);
      await launcher(page).click();
      await ask(page, 'Un rosso per stasera?');

      await expect(panel(page)).toContainText(QUOTA);
      await expect(panel(page)).not.toContainText(DISABLED);
      expect(harness.providerCalls()).toBe(before);
    });
  }
});

test.describe('a winery that is not served', () => {
  for (const slug of ['trialing-expired', 'past-due', 'subscription-ended'] as const) {
    test(`${slug} shows the disabled state, not the capped one, and opens nothing`, async ({
      page,
    }) => {
      const before = harness.providerCalls();

      await visit(page, slug);

      await expect(launcher(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(launcher(page)).toHaveAttribute('aria-label', DISABLED);

      await launcher(page).click({ force: true });

      await expect(panel(page)).toHaveCount(0);
      expect(harness.providerCalls()).toBe(before);
    });
  }
});

test.describe('an install that was never finished', () => {
  test('pending-verification renders nothing at all: no launcher, no error', async ({ page }) => {
    await visit(page, 'pending-verification');

    /* The config is refused (an unverified origin), so the launcher goes. */
    await expect(page.locator('sommelier-widget')).toHaveCount(0, { timeout: 20_000 });
  });
});

test.describe('the hard cases (P3-22)', () => {
  test('blocked mid-conversation: the next message is refused, and the conversation stays', async ({
    page,
  }) => {
    const before = harness.providerCalls();

    await visit(page, 'active-healthy');
    await launcher(page).click();

    for (const question of ['Un bianco?', 'E un rosso?', 'Qualcosa di dolce?']) {
      await ask(page, question);
      await expect(panel(page).locator('.chat-log')).toContainText(question);
    }

    await expect
      .poll(() => panel(page).locator('.chat-log').textContent())
      .toMatch(new RegExp(`(${STATE_REPLY}.*){3}`, 'su'));

    /* The winery's payment fails, by the webhook path, while the panel is open. */
    await harness.dev.apply(tenantOf('active-healthy'), 'fail_payment');

    await ask(page, 'E con il pesce?');

    await expect(panel(page)).toContainText(DISABLED);
    /* Not an error with a retry that can never succeed (§1.3)… */
    await expect(panel(page).locator('.notice-retry')).toHaveCount(0);
    /* …and not a reset: what they were reading is still there. */
    await expect(panel(page).locator('.chat-log')).toContainText('Qualcosa di dolce?');
    expect(harness.providerCalls()).toBe(before + 3);
  });

  test('blocked behind a stale edge cache: active-looking, then disabled gracefully', async ({
    page,
  }) => {
    /*
     * The config is edge-cached for a minute (§5.7), so a shopper can be handed
     * a config from before the block. Served here as the cache would serve it.
     */
    await page.route('**/v1/widget/config**', async (route) => {
      const response = await route.fetch();
      const config = (await response.json()) as Record<string, unknown>;

      await route.fulfill({ response, json: { ...config, status: 'ACTIVE' } });
    });

    const before = harness.providerCalls();

    await visit(page, 'past-due');
    await expect(launcher(page)).not.toHaveAttribute('aria-disabled', 'true');

    await launcher(page).click();
    await ask(page, 'Cosa mi consigli?');

    await expect(panel(page)).toContainText(DISABLED);
    await expect(panel(page).locator('.notice-retry')).toHaveCount(0);
    expect(harness.providerCalls()).toBe(before);
  });

  test('recovery is automatic: a paid retry, and the next page view answers', async ({ page }) => {
    /* `active-healthy` was blocked two tests ago; Stripe's retry succeeds. */
    await harness.dev.apply(tenantOf('active-healthy'), 'recover');

    await visit(page, 'active-healthy');
    await launcher(page).click();
    await ask(page, 'Di nuovo: un rosso?');

    await expect(panel(page).locator('.chat-log')).toContainText(STATE_REPLY);
  });
});
