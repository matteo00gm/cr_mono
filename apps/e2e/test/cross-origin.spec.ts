import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

import { SCRIPTED_REASON, SCRIPTED_REPLY, start, type Harness } from './setup.js';

/**
 * The most important test in the project (P3-18, §6.3).
 *
 * **P2-09 proves the headers are right; only a real browser proves the browser
 * enforces them.** Everything about the anti-sharing design rests on that being
 * true in practice: a seller who pastes their key on a domain they did not
 * verify, or a competitor who lifts the snippet out of a page source, is stopped
 * by the browser refusing a response — not by anything we can assert in Node.
 *
 * **One database, one API, two ports, in that order.** The suite is serial
 * because one test deliberately un-verifies the domain the others depend on,
 * and because a second worker would race it.
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
  /*
   * **The suite is serial and shares one database on purpose**, because
   * standing up a container per test would cost minutes. One test un-verifies
   * the domain every other test depends on, so the state is put back here
   * rather than left for the next test to trip over.
   */
  harness.verified.reset();
  harness.unverified.reset();
  await harness.api.reverifyDomain();
});

/** The widget's own host element, once the loader has mounted it. */
const launcher = (page: Page) => page.locator('sommelier-widget').locator('button').first();

const panel = (page: Page) => page.locator('sommelier-widget').locator('.panel');

/** Everything the page complained about, which is where a CORS refusal lands. */
const consoleOf = (page: Page): string[] => {
  const lines: string[] = [];

  page.on('console', (message: ConsoleMessage) => lines.push(message.text()));
  page.on('pageerror', (error: Error) => lines.push(error.message));

  return lines;
};

test.describe('from a verified domain', () => {
  test('mounts the launcher on the seller page', async ({ page }) => {
    await page.goto(harness.verified.origin);

    await expect(launcher(page)).toBeVisible();
  });

  test('reads the config and never touches the widget bundle until a click', async ({ page }) => {
    /*
     * §1.2's whole promise: a page view costs one small script. Every other page
     * of the storefront — which is almost all of them — pays nothing more.
     */
    const requested: string[] = [];

    page.on('request', (request) => requested.push(request.url()));

    await page.goto(harness.verified.origin);
    await expect(launcher(page)).toBeVisible();

    expect(requested.some((url) => url.includes('/v1/widget/config'))).toBe(true);
    expect(requested.some((url) => url.includes('/widget/widget.js'))).toBe(false);
  });

  test('fetches the widget on the first click and opens the panel', async ({ page }) => {
    await page.goto(harness.verified.origin);
    await launcher(page).click();

    await expect(panel(page)).toBeVisible();
  });

  test('mints a session and streams an answer into the page', async ({ page }) => {
    /*
     * The full path: config, session, chat. Every hop crosses an origin the API
     * has never seen except in its own `tenant_domains` table.
     */
    await page.goto(harness.verified.origin);
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();

    const composer = panel(page).locator('.composer-input');

    await composer.fill('Cosa mi consigli con una bistecca?');
    await composer.press('Enter');

    await expect(panel(page).locator('.chat-log')).toContainText(SCRIPTED_REPLY);
  });

  test('renders a card built from the catalogue', async ({ page }) => {
    // §1.5: the model names an id and writes a reason; the rest is our row.
    await page.goto(harness.verified.origin);
    await launcher(page).click();

    const composer = panel(page).locator('.composer-input');

    await composer.fill('Un rosso strutturato');
    await composer.press('Enter');

    const card = panel(page).locator('.card').first();

    await expect(card).toContainText('Barolo Bussia');
    await expect(card).toContainText(SCRIPTED_REASON);
  });

  test('does not style every control in the panel as a launcher', async ({ page }) => {
    /*
     * **The bug this test exists for shipped, and only a browser could see it.**
     * The launcher's stylesheet used a bare `button` selector. The shadow root
     * scopes that away from the *shop* — which is what it is for — but the panel
     * lives in the same root, so every control inside it rendered as a 56px
     * circle pinned to the bottom-right corner, stacked on the launcher and on
     * each other. JSDOM applies no CSS, so the whole unit suite was green.
     */
    await page.goto(harness.verified.origin);
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();

    const send = panel(page).locator('.composer-send');
    const box = await send.boundingBox();

    expect(box).not.toBeNull();
    /* A button shaped like a button, not like the launcher. */
    expect(box?.width).not.toBe(56);
    expect(box?.height).not.toBe(56);

    /* And inside the panel rather than pinned to the viewport corner. */
    const panelBox = await panel(page).boundingBox();

    expect(box?.y ?? 0).toBeLessThan((panelBox?.y ?? 0) + (panelBox?.height ?? 0));
    expect(box?.y ?? 0).toBeGreaterThanOrEqual(panelBox?.y ?? 0);
  });

  test('adds to the shop own cart, carrying the session property', async ({ page }) => {
    /*
     * **The line that makes P6-07 possible.** Attribution cannot be
     * reconstructed after the fact, so an order placed without `_somm_session`
     * is one we can never claim — and this is the only test that proves the
     * property survives a real fetch to a real endpoint on the shop's origin.
     */
    await page.goto(harness.verified.origin);
    await launcher(page).click();

    const composer = panel(page).locator('.composer-input');

    await composer.fill('Un rosso strutturato');
    await composer.press('Enter');

    /* Wait for the card before pressing its button: the panel animates in, and
     * clicking at a moving element is a flake rather than a finding. */
    const add = panel(page).locator('.card-add').first();

    await expect(add).toBeVisible();
    await add.click();

    await expect
      .poll(
        async () => (await (await fetch(`${harness.verified.origin}/__calls`)).json()) as unknown[],
      )
      .toHaveLength(1);

    const [call] = harness.verified.calls();
    const body = call?.body as { items: { id: string; properties: Record<string, string> }[] };

    expect(body.items[0]?.id).toBe('45123456789');
    expect(body.items[0]?.properties._somm_session).toBeTruthy();
  });
});

test.describe('on a page with a strict CSP and a hostile reset', () => {
  test('mounts, and is styled, under `style-src self`', async ({ page }) => {
    /*
     * **The requirement this removes was real.** A `<style>` element is governed
     * by `style-src` wherever it is created, so building the stylesheet that way
     * asked every seller on a strict policy for `'unsafe-inline'` — and a seller
     * with a payment form on the same page is the one least willing to give it.
     * P3-18 adopts a constructed stylesheet instead, which is a script operation
     * covered by the `script-src` they already allow.
     *
     * Only a browser can say whether that worked: a policy violation is a
     * console error and a silently unstyled widget, which reads exactly like a
     * CSS bug.
     */
    const lines = consoleOf(page);

    await page.goto(`${harness.verified.origin}/hostile`);
    await expect(launcher(page)).toBeVisible();

    /* Styled, not merely present: the launcher's own rule has to have applied. */
    const box = await launcher(page).boundingBox();

    expect(box?.width).toBe(56);
    expect(box?.height).toBe(56);

    expect(lines.join('\n')).not.toMatch(/Content Security Policy|Refused to apply/iu);
  });

  test('injects no style element at all', async ({ page }) => {
    await page.goto(`${harness.verified.origin}/hostile`);
    await expect(launcher(page)).toBeVisible();

    const styles = await page.evaluate(
      () =>
        document.querySelector('sommelier-widget')?.shadowRoot?.querySelectorAll('style').length,
    );

    expect(styles).toBe(0);
  });

  test('lets none of the shop reset reach inside, and none of ours reach out', async ({ page }) => {
    /*
     * Both directions. The page's `* { all: unset }` and its wildcard
     * `display: none !important` would flatten the launcher if they could reach
     * it; our own rules must equally not touch the shop's own markup.
     */
    await page.goto(`${harness.verified.origin}/hostile`);
    await expect(launcher(page)).toBeVisible();

    const marker = page.locator('#marker');

    await expect(marker).toBeVisible();
    await expect(marker).toHaveCSS('color', 'rgb(17, 17, 17)');
  });
});

test.describe('from a domain nobody verified', () => {
  test('the browser blocks the config request', async ({ page }) => {
    /*
     * **Asserted as an absence and a complaint.** The API answers; the browser
     * refuses to hand the answer to the page, which is the only place this
     * enforcement exists. A widget that mounted here would mean the whole
     * origin allowlist is decoration.
     */
    const lines = consoleOf(page);

    await page.goto(harness.unverified.origin);

    /* The launcher mounts before the config is read — it is what a click would
     * use — but the config never resolves, so nothing beyond it happens. */
    await expect(launcher(page)).toHaveAttribute('aria-disabled', 'true');

    expect(lines.join('\n')).toMatch(/CORS|Access-Control-Allow-Origin|blocked/iu);
  });

  test('never opens a panel, however hard the visitor tries', async ({ page }) => {
    await page.goto(harness.unverified.origin);
    await expect(launcher(page)).toHaveAttribute('aria-disabled', 'true');

    await launcher(page).click({ force: true });

    await expect(panel(page)).toHaveCount(0);
  });

  test('is recorded server-side as a refused origin', async ({ page }) => {
    /*
     * The browser's refusal is invisible to us; this row is how a seller who
     * pasted their key on the wrong domain is discoverable at all (P2-16).
     */
    await page.goto(harness.unverified.origin);
    await expect(launcher(page)).toHaveAttribute('aria-disabled', 'true');

    await expect
      .poll(async () => await harness.api.securityEvents(), { timeout: 10_000 })
      .toContainEqual(
        expect.objectContaining({ type: 'UNAUTHORIZED_ORIGIN', origin: harness.unverified.origin }),
      );
  });
});

test.describe('when a domain stops being verified', () => {
  test('the next uncached request from that storefront is refused', async ({ page }) => {
    /*
     * §5.7's immediate effect, asserted where it is actually observable.
     *
     * **A reload does not prove this, and the first version of this test tried
     * to.** The config response is deliberately cacheable — `public,
     * max-age=60` (P2-10), because it is edge-cached and world-readable — so a
     * shopper who reloads inside that minute is answered by their own browser
     * and never reaches us. That is correct, and it means the *config* is the
     * one request that cannot show an immediate effect.
     *
     * The session mint is not cached and cannot be: it is a POST. So the panel
     * opens from the cached config and the first question is refused, which is
     * exactly what a visitor would experience on a domain the seller has just
     * removed.
     */
    await page.goto(harness.verified.origin);
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();

    await harness.api.unverifyDomain();

    const composer = panel(page).locator('.composer-input');

    await composer.fill('Un rosso strutturato');
    await composer.press('Enter');

    /* Not a spinner and not a silence: the visitor is told (§1.3). */
    await expect(panel(page).locator('.notice-text')).toBeVisible();
    await expect(panel(page).locator('.chat-log')).not.toContainText(SCRIPTED_REPLY);
  });

  test('records the refusal server-side', async ({ page }) => {
    await page.goto(harness.verified.origin);
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();

    await harness.api.unverifyDomain();

    const composer = panel(page).locator('.composer-input');

    await composer.fill('Un rosso strutturato');
    await composer.press('Enter');

    await expect
      .poll(async () => await harness.api.securityEvents(), { timeout: 10_000 })
      .toContainEqual(
        expect.objectContaining({ type: 'UNAUTHORIZED_ORIGIN', origin: harness.verified.origin }),
      );
  });
});

test.describe('when a removed domain is verified again (P4-06)', () => {
  test.afterEach(async () => {
    await harness.api.restoreSessions();
  });

  test('the session that was live when it was removed stays dead', async ({ page }) => {
    /*
     * **The one property CORS cannot provide, and the reason the cutoff exists
     * at all.**
     *
     * Removal is already immediate today because the allowlist is uncached — a
     * removed origin is refused before a token is read. But a seller who
     * removes an origin and later verifies it again puts it *back* in the
     * allowlist, and without a cutoff every session that was live at the moment
     * of removal starts working again. Nothing about CORS notices.
     *
     * So this leaves the origin verified throughout and ends the sessions, which
     * is the only arrangement where the cutoff is the thing under test. The
     * visitor is holding a token minted before the cutoff; their next question
     * has to be refused.
     */
    await page.goto(harness.verified.origin);
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();

    const composer = panel(page).locator('.composer-input');

    /* A live session first, so the refusal below is a change and not the
     * starting state. */
    await composer.fill('Cosa mi consigli con una bistecca?');
    await composer.press('Enter');
    await expect(panel(page).locator('.chat-log')).toContainText(SCRIPTED_REPLY);

    await harness.api.endSessions();

    await composer.fill('E con il pesce?');
    await composer.press('Enter');

    /* Told, not spun (§1.3). */
    await expect(panel(page).locator('.notice-text')).toBeVisible();
  });

  test('records it as an invalid token rather than a stolen widget', async ({ page }) => {
    /*
     * The origin is verified and the key is right — this is a seller ending
     * their own sessions, not somebody presenting a token at a site it was not
     * minted for. `UNAUTHORIZED_ORIGIN` would tell an incident review the wrong
     * story entirely.
     */
    await page.goto(harness.verified.origin);
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();

    const composer = panel(page).locator('.composer-input');

    await composer.fill('Cosa mi consigli con una bistecca?');
    await composer.press('Enter');
    await expect(panel(page).locator('.chat-log')).toContainText(SCRIPTED_REPLY);

    await harness.api.endSessions();

    await composer.fill('E con il pesce?');
    await composer.press('Enter');

    await expect
      .poll(async () => await harness.api.securityEvents(), { timeout: 10_000 })
      .toContainEqual(
        expect.objectContaining({ type: 'INVALID_TOKEN', origin: harness.verified.origin }),
      );
  });
});
