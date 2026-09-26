import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { DASHBOARD_CSP } from '../../../infra/headers.js';

/**
 * The dashboard under the CSP CloudFront will send (P4-12).
 *
 * **The same string, imported, not copied.** `infra/headers.ts` is what the
 * distribution sends; a test that served its own copy would pass while the two
 * drifted. And the same bundle: the built `apps/dashboard/dist`, which is what
 * the deploy uploads.
 *
 * Two assertions, and the second is what makes the first worth anything: the
 * real bundle boots with no violation at all, and an inline script injected
 * into the same page is refused — so a bundle that *did* need `unsafe-inline`
 * would fail this run rather than a seller's first page load.
 */

const PORT = 4010;
const DIST = join(import.meta.dirname, '..', '..', 'dashboard', 'dist');

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** The SPA, as CloudFront serves it: a file if one exists, `index.html` if not. */
const serve = (): Server =>
  createServer((request, response) => {
    const path = normalize(new URL(request.url ?? '/', 'http://localhost').pathname);
    const candidate = join(DIST, path);
    let file = join(DIST, 'index.html');

    try {
      if (candidate.startsWith(DIST) && statSync(candidate).isFile()) file = candidate;
    } catch {
      /* Not a file: the SPA answers, as the rewrite function does. */
    }

    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': DASHBOARD_CSP,
    });
    response.end(readFileSync(file));
  });

let server: Server;

test.beforeAll(async () => {
  server = serve();
  await new Promise<void>((resolve) => {
    server.listen(PORT, '127.0.0.1', resolve);
  });
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

/**
 * Every violation the page reports, collected from the first byte.
 *
 * Registered through Playwright's init script, which the page's own CSP does
 * not govern — so the listener is in place before any of the bundle runs.
 */
const watchViolations = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (globalThis as unknown as { __violations: string[] }).__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
};

const violations = (page: Page): Promise<string[]> =>
  page.evaluate(() => (globalThis as unknown as { __violations: string[] }).__violations);

test.describe('the dashboard under its CSP', () => {
  test('boots and renders with no violation at all', async ({ page }) => {
    await watchViolations(page);
    await page.goto(`http://localhost:${String(PORT)}/`);

    /* Signed out, because there is no API here — which still means it rendered. */
    await expect(page.getByRole('link', { name: 'Accedi' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('refuses an inline script injected into the page', async ({ page }) => {
    await watchViolations(page);
    await page.goto(`http://localhost:${String(PORT)}/`);
    await expect(page.getByRole('link', { name: 'Accedi' })).toBeVisible();

    const ran = await page.evaluate(async () => {
      const script = document.createElement('script');
      script.textContent = 'globalThis.__inlineRan = true;';
      document.head.append(script);
      await new Promise((resolve) => setTimeout(resolve, 50));

      return (globalThis as unknown as { __inlineRan?: boolean }).__inlineRan === true;
    });

    expect(ran).toBe(false);
    expect((await violations(page)).some((line) => line.startsWith('script-src'))).toBe(true);
  });

  test('refuses to be framed by another page', async ({ page }) => {
    /*
     * `frame-ancestors 'none'`: a page on another origin that frames the
     * dashboard gets an empty frame — the clickjacking the header exists for.
     */
    await page.setContent(`<iframe id="framed" src="http://localhost:${String(PORT)}/"></iframe>`);

    const frame = page.frame({ url: /localhost:4010/u });

    await expect
      .poll(async () => (await frame?.content())?.includes('Accedi') ?? false, { timeout: 3_000 })
      .toBe(false);
  });
});
