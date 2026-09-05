import { handle } from 'hono/aws-lambda';

import { createApp } from './app.js';

/**
 * The Lambda entry point (P0-54).
 *
 * Kept apart from `app.ts` so the app itself is reachable without the AWS
 * shim: every test in this package builds a `Hono` instance and calls
 * `app.request(...)`, which needs no event envelope, no context object and no
 * AWS at all. Folding `handle()` into the composition root would mean every
 * suite imported the Lambda adapter to get at the routes.
 *
 * `handle`, not `streamHandle`: this function is BUFFERED (§5.1). The streaming
 * chat endpoint gets its own `RESPONSE_STREAM` Function URL in P2-29, because
 * the two modes are a property of the *function*, not of the route — a single
 * streaming function would make every ordinary JSON response pay the streaming
 * envelope, and CloudFront needs different cache behaviour for each (P0-17a).
 */

/** Built once per container, so route registration is not per-invocation work. */
export const handler = handle(createApp());

export { createApp } from './app.js';
