import process from 'node:process';
import { Hono } from 'hono';

import { errorHandler, normaliseThrown, notFoundHandler } from './middleware/error.js';
import { requestContext } from './middleware/logger.js';
import { createDashboardApp } from './surfaces/dashboard.js';
import { createWidgetApp } from './surfaces/widget.js';

/**
 * The API composition root (P0-54).
 *
 * Every endpoint in the product attaches to one of the two sub-apps mounted
 * here. One Lambda serves both (§5.1) — the split is by route group, not by
 * function — with `/v1/widget/chat` later promoted to its own `RESPONSE_STREAM`
 * Function URL (P2-29) while everything here stays BUFFERED.
 *
 * **The parent app carries no surface-specific middleware, and must not.** It
 * exists to mount and to answer `/v1/health`, nothing more. Anything registered
 * on it runs for the authenticated dashboard *and* the public widget, which is
 * precisely the confusion the two-instance split is there to prevent; the test
 * suite asserts the property directly rather than trusting this comment.
 */

/**
 * A factory, not a module-level singleton.
 *
 * Two reasons, and the second is the one that bites. Tests need an app they can
 * configure — P0-46 mounts a stub session, P0-50 enumerates routes — and a
 * shared instance leaks that configuration between them. And `app.route()`
 * mutates the app it is called on, so a singleton mounted twice accumulates
 * duplicate routes, where the first registration wins and the second is dead
 * code that looks live.
 */
export const createApp = (): Hono => {
  const app = new Hono();

  /*
   * Registered first, and that is load-bearing rather than tidy. Hono matches
   * handlers in registration order, so middleware added below a route never
   * runs for it (P0-54) — a request context opened after the routes would give
   * a suite that passes and a production system whose logs carry no tenant.
   *
   * This is also the one thing the parent app legitimately owns: it is not
   * surface-specific, and every request on both surfaces needs it.
   */
  app.use('*', requestContext());

  /*
   * Immediately inside the request context, and before every route.
   *
   * Hono rethrows a thrown non-`Error` instead of calling `onError`, so without
   * this a `throw 'oops'` anywhere in the product escapes the app entirely and
   * the caller gets the Lambda runtime's raw 502 — bypassing the envelope, the
   * request id and the disclosure rules all at once. Inside the context
   * middleware rather than outside it, so the resulting 500 still carries a
   * real request id.
   */
  app.use('*', normaliseThrown());

  /*
   * `onError` and `notFound` are not middleware and are order-independent, but
   * they belong beside the middleware they cooperate with: both read the
   * request id out of the context opened above.
   */
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  /**
   * Health, under `/v1/` deliberately.
   *
   * CloudFront routes `/v1/*` to this Lambda (§5.1); a `/health` at the root
   * would be reachable on the Function URL directly but not through the edge,
   * so the check would pass while the path every real caller uses was broken.
   * Checking the same route the traffic takes is the entire value of a health
   * endpoint.
   *
   * It reports the build SHA because "is it up" is rarely the real question —
   * "is the thing I just deployed the thing that is running" is, and answering
   * it from a header is guesswork.
   */
  app.get('/v1/health', (c) => c.json({ status: 'ok' as const, sha: buildSha() }));

  app.route('/v1/dashboard', createDashboardApp());
  app.route('/v1/widget', createWidgetApp());

  return app;
};

/**
 * The commit this bundle was built from, injected at deploy time (`infra/api.ts`).
 *
 * `unknown` rather than a throw: a health endpoint that 500s because a build
 * variable is missing reports the deployment as dead when it is serving traffic
 * perfectly well, and that is a worse failure than an unlabelled SHA. Local runs
 * and tests legitimately have no SHA.
 *
 * Empty counts as missing, and that is the case that actually happens. `??`
 * alone would not do it: `infra/api.ts` injects `process.env.GITHUB_SHA ?? ''`,
 * so outside CI the variable is *set and empty* rather than absent, and a health
 * check reporting `sha: ""` looks like a deploy that lost its build metadata
 * instead of one that never had any.
 */
const buildSha = (): string => {
  const sha = process.env.BUILD_SHA?.trim() ?? '';
  return sha === '' ? 'unknown' : sha;
};
