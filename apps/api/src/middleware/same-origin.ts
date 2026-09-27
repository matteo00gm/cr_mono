import { ForbiddenError } from '@catalogorosso/core';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';

/**
 * State-changing dashboard requests come from the dashboard, or not at all
 * (review, R5).
 *
 * The session cookie is `SameSite=Lax`, which stops a cross-*site* page from
 * sending it with a POST. It does nothing about a same-*site* one: once the
 * dashboard has a custom domain, a compromised sibling subdomain is same-site,
 * and could post to every dashboard route with the owner's cookie attached.
 *
 * **A browser always says where a request came from**: `Origin` on every
 * cross-origin request that is not a GET, and `Sec-Fetch-Site` on every request
 * in the browsers that matter. So a write whose `Origin` is not the dashboard's,
 * or that the browser itself marks `cross-site` or `same-site`, is refused. A
 * caller that sends neither is not a browser, and so cannot be the victim of
 * CSRF — which is why their absence is allowed rather than refused.
 *
 * Reads are left alone: they change nothing, and the answer to a cross-origin
 * read is withheld by the browser, since this surface sends no CORS headers.
 */

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CROSS_ORIGIN_REFUSED = 'This request did not come from the dashboard.';

export const requireSameOrigin =
  (dashboardOrigin: string): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');

      if (origin !== undefined && origin !== dashboardOrigin) {
        throw new ForbiddenError(CROSS_ORIGIN_REFUSED);
      }

      if (site === 'cross-site' || site === 'same-site') {
        throw new ForbiddenError(CROSS_ORIGIN_REFUSED);
      }
    }

    await next();
  };
