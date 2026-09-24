import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startHostPages,
  UNVERIFIED_PORT,
  VERIFIED_PORT,
  type HostPages,
} from '../src/host-pages.js';

/**
 * The harness proving itself (P3-17).
 *
 * **A test harness that is wrong is worse than no harness**, because every
 * suite built on it reports the harness's bug as the product's. So the pages
 * are checked for the three things P3-18 will read off them: that the snippet
 * carries this run's key and API, that the fake Shopify cart records what it
 * was told, and that both ports serve the same page from the same file.
 *
 * The browser half is P3-18's — nothing here renders anything.
 */

const API = 'http://localhost:4000';
const KEY = 'pk_test_harness';

let bundle: string;
let verified: HostPages;
let unverified: HostPages;

beforeAll(async () => {
  /*
   * A stand-in bundle rather than the real one: this suite is about the
   * harness, and depending on a built widget would make it fail for a reason
   * that has nothing to do with what it asserts.
   */
  bundle = await mkdtemp(join(tmpdir(), 'host-pages-'));
  await writeFile(join(bundle, 'loader.js'), 'globalThis.__loaded = true;\n', 'utf8');

  verified = await startHostPages({
    port: VERIFIED_PORT,
    api: API,
    widgetKey: KEY,
    bundleDir: bundle,
  });
  unverified = await startHostPages({
    port: UNVERIFIED_PORT,
    api: API,
    widgetKey: KEY,
    bundleDir: bundle,
  });
});

afterAll(async () => {
  await verified.close();
  await unverified.close();
});

const get = async (origin: string, path: string): Promise<Response> => fetch(`${origin}${path}`);

/** The page without its comments, so prose about a thing is not the thing. */
const scriptIn = (html: string): string => html.replaceAll(/<!--[\s\S]*?-->/gu, '');

/** Just the policy, for the same reason. */
const cspIn = (html: string): string => /content="([^"]*)"/u.exec(scriptIn(html))?.[1] ?? '';

describe('the storefront', () => {
  it('serves a page with the seller snippet in it', async () => {
    const html = await (await get(verified.origin, '/')).text();

    expect(html).toContain('src="/widget/loader.js"');
  });

  it('loads the snippet as a module, which the loader requires', async () => {
    /*
     * **`type="module"` is load-bearing** (P3-18). The loader reaches the widget
     * bundle through a dynamic `import()`, which resolves against the bundle's
     * own URL only in a module — a classic script resolves it against the shop's
     * document base and cannot use `import.meta` at all. As shipped before this
     * suite existed, the built loader threw on every storefront.
     */
    const html = await (await get(verified.origin, '/')).text();

    expect(html).toMatch(/<script[^>]*type="module"/u);
  });

  it('fills the snippet with this run key and API', async () => {
    /* A placeholder that survived would make every widget request 404 with no
     * hint as to why. */
    const html = await (await get(verified.origin, '/')).text();

    expect(html).toContain(`data-key="${KEY}"`);
    expect(html).toContain(`data-api="${API}"`);
    expect(html).not.toContain('__WIDGET_KEY__');
    expect(html).not.toContain('__API__');
  });

  it('looks like a Shopify storefront to anything that asks', async () => {
    // `window.Shopify` is what every theme sets and what `resolveCart` reads.
    const html = await (await get(verified.origin, '/')).text();

    expect(scriptIn(html)).toContain('window.Shopify =');
  });

  it('serves the bundle from the host page own origin', async () => {
    const response = await get(verified.origin, '/widget/loader.js');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
  });

  it('answers 404 for a path nobody defined', async () => {
    expect((await get(verified.origin, '/nonesiste')).status).toBe(404);
  });
});

describe('two ports, one page', () => {
  it('serves byte-identical pages, so the origin is the only difference', async () => {
    /*
     * **The property the whole cross-origin suite rests on.** If these two ever
     * differ, a widget that fails on `:4002` proves nothing: it could be the
     * CORS refusal the suite is looking for, or it could be a typo in a second
     * copy of the page.
     */
    const [first, second] = await Promise.all([
      (await get(verified.origin, '/')).text(),
      (await get(unverified.origin, '/')).text(),
    ]);

    expect(first).toBe(second);
  });

  it('serves them from origins a browser treats as different', () => {
    expect(verified.origin).not.toBe(unverified.origin);
  });
});

describe('the fake Shopify cart', () => {
  it('records what the widget sent it', async () => {
    verified.reset();

    await fetch(`${verified.origin}/cart/add.js`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ id: '45123456789', quantity: 1, properties: { _somm_session: 'sess-1' } }],
      }),
    });

    expect(verified.calls()).toHaveLength(1);
    expect(verified.calls()[0]?.body).toMatchObject({
      items: [{ id: '45123456789', properties: { _somm_session: 'sess-1' } }],
    });
  });

  it('is readable over HTTP, because a browser test cannot read our memory', async () => {
    verified.reset();

    await fetch(`${verified.origin}/cart/add.js`, {
      method: 'POST',
      body: JSON.stringify({ items: [{ id: '1', quantity: 1 }] }),
    });

    const recorded = (await (await get(verified.origin, '/__calls')).json()) as unknown[];

    expect(recorded).toHaveLength(1);
  });

  it('counts what it has been given', async () => {
    verified.reset();

    await fetch(`${verified.origin}/cart/add.js`, {
      method: 'POST',
      body: JSON.stringify({ items: [{ id: '1', quantity: 1 }] }),
    });

    expect(await (await get(verified.origin, '/cart.js')).json()).toEqual({ item_count: 1 });
  });

  it('refuses a sold-out variant the way Shopify does', async () => {
    /* 422 with a `description` written for a shopper, which the widget passes
     * through rather than replacing (P3-11). */
    verified.reset();

    const response = await fetch(`${verified.origin}/cart/add.js`, {
      method: 'POST',
      body: JSON.stringify({ items: [{ id: 'sold-out', quantity: 1 }] }),
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as { description: string }).description).toContain('esaurito');
  });

  it('forgets on reset, so one test cannot see another test cart', () => {
    verified.reset();

    expect(verified.calls()).toEqual([]);
  });
});

describe('the other two pages', () => {
  it('serves a site with its own cart contract', async () => {
    const html = await (await get(verified.origin, '/generic')).text();

    expect(html).toContain('window.__sommelierCart');
    /* And *not* a Shopify one: the detection has to reach the second branch.
     * Asserted on the script rather than the page, because the prose above it
     * explains what this page is instead of. */
    expect(scriptIn(html)).not.toContain('window.Shopify =');
  });

  it('serves a page that is trying to flatten us', async () => {
    const html = await (await get(verified.origin, '/hostile')).text();

    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('/hostile.css');
  });

  it('names the API in the CSP, because the widget must be allowed to reach it', async () => {
    /* A line in the seller documentation, and this page is where we find out it
     * is the right line. */
    const html = await (await get(verified.origin, '/hostile')).text();

    expect(html).toContain(`connect-src 'self' ${API}`);
  });

  it('forbids inline and evaluated script, which the loader is written to survive', async () => {
    /*
     * P3-01: no `eval`, no `new Function`, no `document.write`. Read off the
     * policy rather than the page, because the comment above it names the
     * things it forbids and that is the point of the comment.
     */
    const policy = cspIn(await (await get(verified.origin, '/hostile')).text());
    const scriptSrc = /script-src ([^;]*)/u.exec(policy)?.[1] ?? '';

    expect(scriptSrc).toBe("'self'");
    expect(policy).not.toContain('unsafe-eval');
  });

  it('forbids inline style too, which the widget no longer needs', async () => {
    /*
     * **This used to say the opposite.** The widget built its stylesheet as a
     * `<style>` element, and CSP governs those wherever they are created — so
     * every seller on a strict policy had to add `'unsafe-inline'` to
     * `style-src` or lose every style. P3-18 adopts a constructed stylesheet
     * instead, which is a script operation covered by the `script-src` they
     * already allow, and the requirement is gone.
     *
     * The page asserting it is the page that proves it: the widget has to look
     * right under this policy, in a real browser (P3-18).
     */
    const policy = cspIn(await (await get(verified.origin, '/hostile')).text());
    const styleSrc = /style-src ([^;]*)/u.exec(policy)?.[1] ?? '';

    expect(styleSrc).toBe("'self'");
  });

  it('serves a reset that would flatten anything it could reach', async () => {
    const css = await (await get(verified.origin, '/hostile.css')).text();

    expect(css).toContain('all: unset');
    expect(css).toContain('display: none !important');
  });
});
