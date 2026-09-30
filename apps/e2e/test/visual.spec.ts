import { createRequire } from 'node:module';

import { expect, test, type Page, type Route } from '@playwright/test';

import { SCRIPTED_REASON, SCRIPTED_REPLY, start, type Harness } from './setup.js';

/** axe-core's browser build, injected rather than bundled: it runs in the page. */
const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/**
 * Visual regression: every §1.3 state in both locales, the card list, and the
 * mobile viewport (P3-19).
 *
 * **The widget renders on customers' storefronts**, so a visual regression is
 * seen by their shoppers before it is seen by us. A diff to a baseline here
 * needs an explicit approval in review, which is the point: nobody changes how
 * a seller's shop looks by accident.
 *
 * **Every state is reached through the widget's real network path**, with the
 * response bent at the wire rather than a component rendered in isolation: the
 * config's `status` for `DISABLED`, a 429 with `Retry-After` for
 * `RATE_LIMITED`, a 5xx and a dropped connection for the two `ERROR` notices,
 * and a `quota_exceeded` event mid-stream for `QUOTA_EXCEEDED` — exactly how
 * each arrives in production. A bent response keeps the real one's headers, so
 * CORS is the API's own and not something this file made up.
 *
 * **Baselines are Linux's**, rendered by CI: fonts rasterise differently on
 * every platform, and a baseline from a laptop would fail on the runner for
 * reasons that are not regressions. The path carries the platform, so a local
 * run writes its own files beside them and never compares against CI's.
 */

let harness: Harness;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  harness = await start();
});

test.afterAll(async () => {
  await harness.close();
});

test.beforeEach(async () => {
  harness.verified.reset();
  /*
   * Sixteen screenshots of config, session and chat outrun a trial winery's
   * thirty requests a minute, and the thirty-first refuses the config — which
   * renders as a greyed launcher, a baseline of the wrong state. Each test gets
   * a fresh window; none of them is about the limit (the rate-limited state is
   * a bent response, below).
   */
  harness.nextMinute();
  await harness.api.reverifyDomain();
});

const widget = (page: Page) => page.locator('sommelier-widget');
const launcher = (page: Page) => widget(page).locator('button').first();
const panel = (page: Page) => widget(page).locator('.panel');

/** Opens the panel and asks one question, as a shopper would. */
const ask = async (page: Page, question = 'Un rosso strutturato'): Promise<void> => {
  await launcher(page).click();
  await expect(panel(page)).toBeVisible();

  const composer = panel(page).locator('.composer-input');

  await composer.fill(question);
  await composer.press('Enter');
};

/** Replaces the chat response with one of a given shape, keeping the real one's headers. */
const bendChat = async (page: Page, bend: (route: Route) => Promise<void>): Promise<void> => {
  await page.route('**/v1/widget/chat*', bend);
};

const refusal =
  (status: number, code: string, extra: Record<string, string> = {}) =>
  async (route: Route): Promise<void> => {
    const real = await route.fetch();

    await route.fulfill({
      response: real,
      status,
      headers: { ...real.headers(), 'content-type': 'application/json', ...extra },
      body: JSON.stringify({ error: { code, message: 'refused', requestId: 'visual' } }),
    });
  };

const LOCALES = [
  { locale: 'it', tag: 'it-IT' },
  { locale: 'en', tag: 'en-GB' },
] as const;

for (const { locale, tag } of LOCALES) {
  test.describe(`in ${locale}`, () => {
    test.use({ locale: tag });

    test('DISABLED: a greyed launcher, and nothing else loads', async ({ page }) => {
      await page.route('**/v1/widget/config*', async (route) => {
        const real = await route.fetch();
        const config = (await real.json()) as Record<string, unknown>;

        await route.fulfill({ response: real, json: { ...config, status: 'DISABLED' } });
      });

      /*
       * **A refused config renders this same launcher**, so the screenshot alone
       * would pass for a CORS failure. The response is read back: it arrived,
       * the API let this origin read it, and it said `DISABLED`.
       */
      const config = page.waitForResponse('**/v1/widget/config*');

      await page.goto(harness.verified.origin);

      const response = await config;

      expect(response.status()).toBe(200);
      expect(response.headers()['access-control-allow-origin']).toBe(harness.verified.origin);
      expect(((await response.json()) as { status: string }).status).toBe('DISABLED');
      await expect(launcher(page)).toHaveAttribute('aria-disabled', 'true');

      await expect(page).toHaveScreenshot(`disabled-${locale}.png`);
    });

    test('ACTIVE: the welcome and the suggestions', async ({ page }) => {
      await page.goto(harness.verified.origin);
      await launcher(page).click();
      await expect(panel(page)).toBeVisible();

      await expect(page).toHaveScreenshot(`active-${locale}.png`);
    });

    test('the card list, after an answer', async ({ page }) => {
      await page.goto(harness.verified.origin);
      await ask(page);

      await expect(panel(page).locator('.card').first()).toContainText(SCRIPTED_REASON);
      await expect(panel(page).locator('.chat-log')).toContainText(SCRIPTED_REPLY);

      await expect(page).toHaveScreenshot(`cards-${locale}.png`);
    });

    test('QUOTA_EXCEEDED: a friendly wall, and nothing about the plan', async ({ page }) => {
      await bendChat(page, async (route) => {
        const real = await route.fetch();

        /* The frame the API writes when `QuotaExceededError` ends an answer. */
        const spent = JSON.stringify({ type: 'error', code: 'quota_exceeded' });

        await route.fulfill({
          response: real,
          body: `event: error\ndata: ${spent}\n\nevent: done\ndata: {}\n\n`,
        });
      });

      await page.goto(harness.verified.origin);
      await ask(page);
      await expect(panel(page).locator('.notice')).toBeVisible();

      await expect(page).toHaveScreenshot(`quota-${locale}.png`);
    });

    test('RATE_LIMITED: an inline notice and a countdown', async ({ page }) => {
      await bendChat(page, refusal(429, 'rate_limited', { 'retry-after': '42' }));

      await page.goto(harness.verified.origin);
      await ask(page);

      const notice = panel(page).locator('.notice');

      /*
       * **The countdown is the one moving part, so its text is masked** and
       * asserted instead. Freezing the clock would freeze Preact's effect
       * scheduling with it; masking keeps the notice's box, its disabled retry
       * button and everything around it under the baseline.
       */
      await expect(notice.locator('.notice-text')).toContainText(/\d/u);
      await expect(notice.locator('.notice-retry')).toBeDisabled();

      await expect(page).toHaveScreenshot(`rate-limited-${locale}.png`, {
        mask: [notice.locator('.notice-text')],
      });
    });

    test('ERROR: the shop could not answer, with a retry', async ({ page }) => {
      await bendChat(page, refusal(503, 'internal'));

      await page.goto(harness.verified.origin);
      await ask(page);
      await expect(panel(page).locator('.notice-retry')).toBeEnabled();

      await expect(page).toHaveScreenshot(`error-provider-${locale}.png`);
    });

    test('OFFLINE: the connection went away, with a retry', async ({ page }) => {
      await bendChat(page, (route) => route.abort('failed'));

      await page.goto(harness.verified.origin);
      await ask(page);
      await expect(panel(page).locator('.notice-retry')).toBeEnabled();

      await expect(page).toHaveScreenshot(`error-network-${locale}.png`);
    });
  });
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, locale: 'it-IT', hasTouch: true });

  test('the open panel', async ({ page }) => {
    await page.goto(harness.verified.origin);
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();

    await expect(page).toHaveScreenshot('mobile-active-it.png');
  });

  test('the card list', async ({ page }) => {
    await page.goto(harness.verified.origin);
    await ask(page);
    await expect(panel(page).locator('.card').first()).toContainText(SCRIPTED_REASON);

    await expect(page).toHaveScreenshot('mobile-cards-it.png');
  });
});

test.describe('on a shop whose stylesheet is trying to flatten it', () => {
  test.use({ locale: 'it-IT' });

  /*
   * **One baseline, two pages** (deferred here by P3-18). The panel is
   * screenshotted on the plain storefront and on the hostile one — a 2014 reset
   * with `* { all: unset }`, wildcard `display: none !important` on every class
   * the widget uses, and `font-size: 0` on the host element itself — and both
   * are compared against the same file. Anything of the shop's that reached
   * inside the shadow root is a pixel diff; the inherited properties are the
   * ones worth fearing, because a shadow root stops selectors and not
   * inheritance.
   */
  for (const [where, path] of [
    ['a plain storefront', '/'],
    ['a hostile one', '/hostile'],
  ] as const) {
    test(`renders the answered panel identically on ${where}`, async ({ page }) => {
      await page.goto(`${harness.verified.origin}${path}`);
      await ask(page);
      await expect(panel(page).locator('.card').first()).toContainText(SCRIPTED_REASON);

      await expect(panel(page)).toHaveScreenshot('panel-cards-it.png');
    });
  }
});

test.describe('the full axe rule set, where layout exists', () => {
  test.use({ locale: 'it-IT' });

  /*
   * **P3-15 runs the structural rules in JSDOM; this runs the rest** (deferred
   * here by P3-18). JSDOM computes no layout, so colour contrast, target size
   * and anything that asks whether a thing is visible could not run there. In
   * Chromium they can, over the panel in each state a shopper meets it.
   *
   * The scan is scoped to the widget. The storefront is the harness's, and a
   * seller's page failing a rule is not something this suite can fix or
   * should report.
   */
  const scan = async (page: Page) => {
    await page.addScriptTag({ path: AXE });

    return page.evaluate(async () => {
      const results = await (
        globalThis as unknown as {
          axe: {
            run: (
              context: unknown,
            ) => Promise<{ violations: { id: string; nodes: { target: unknown }[] }[] }>;
          };
        }
      ).axe.run({ include: [['sommelier-widget']] });

      return results.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map(({ target }) => JSON.stringify(target)),
      }));
    });
  };

  test('the open panel', async ({ page }) => {
    await page.goto(harness.verified.origin);
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();

    expect(await scan(page)).toEqual([]);
  });

  test('an answer with its cards', async ({ page }) => {
    await page.goto(harness.verified.origin);
    await ask(page);
    await expect(panel(page).locator('.card').first()).toContainText(SCRIPTED_REASON);

    expect(await scan(page)).toEqual([]);
  });

  test('a notice with its retry', async ({ page }) => {
    await bendChat(page, refusal(503, 'internal'));

    await page.goto(harness.verified.origin);
    await ask(page);
    await expect(panel(page).locator('.notice-retry')).toBeEnabled();

    expect(await scan(page)).toEqual([]);
  });

  test('the launcher alone, before anything is opened', async ({ page }) => {
    await page.goto(harness.verified.origin);
    await expect(launcher(page)).toBeVisible();

    expect(await scan(page)).toEqual([]);
  });
});
