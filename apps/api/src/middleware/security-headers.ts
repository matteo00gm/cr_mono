import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';
import { DASHBOARD_PREFIX } from '../routes.js';

/**
 * The API's own security headers, on every response (P4-12).
 *
 * CloudFront adds HSTS and `nosniff` too (`infra/headers.ts`), with `override`.
 * These are set here as well so that what the function answers is right on its
 * own — through the Function URL, in `sst dev`, and in every test — rather than
 * right only once an edge nobody can run locally has rewritten it.
 *
 * **After `next()`, on whatever response came back**, so a refusal, a 404, an
 * unexpected 500 and a stream all carry them: Hono turns a thrown error into a
 * response at the level that threw it, and this sees the result.
 */

export const API_HSTS = 'max-age=63072000; includeSubDomains; preload';

/**
 * For a JSON response nobody should ever render as a page: no content may load
 * and no page may frame it. Belt and braces for a response that is never HTML —
 * which is exactly when a sniffing mistake would make it HTML.
 */
export const DASHBOARD_API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * The response's headers, writable. `Response.redirect()` — which Better Auth
 * uses — makes a response whose headers are immutable, and setting one throws;
 * a copy carries the same status, headers and body, unread.
 */
const writableHeaders = (c: Parameters<MiddlewareHandler<AppEnv>>[0]): Headers => {
  try {
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
  } catch {
    c.res = new Response(c.res.body, c.res);
  }

  return c.res.headers;
};

export const securityHeaders = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();

  const headers = writableHeaders(c);

  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Strict-Transport-Security', API_HSTS);

  /*
   * **Framing is denied on the dashboard surface only.** The widget surface is
   * read by pages on sellers' own origins by design, and a framing header on
   * it is a widget that breaks the day a seller puts it in an iframe.
   */
  if (c.req.path === DASHBOARD_PREFIX || c.req.path.startsWith(`${DASHBOARD_PREFIX}/`)) {
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', DASHBOARD_API_CSP);
  }
};
