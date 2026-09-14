/**
 * The CloudFront Functions' source, as strings a test can run (P0-17a).
 *
 * **Separate from `cdn.ts` for the reason `queue-config.ts` is separate from
 * `queue.ts`.** That module constructs SST resources at import time and cannot
 * be loaded outside a deploy, so these two functions — each a guard whose
 * failure is silent — had never been executed by anything except CloudFront.
 * The viewer-IP overwrite is what keeps a forged `X-Forwarded-For` from putting
 * every caller into one rate-limit bucket (A1); the SPA rewrite is what keeps a
 * genuine API 404 from reaching a caller as a dashboard page with a 200 (§3.5).
 *
 * Plain ES5 declaring one global `handler`, because that is the whole contract
 * of the `cloudfront-js-2.0` runtime: a script, no modules, nothing imported.
 * `infra/test/edge-functions.test.ts` evaluates exactly these strings, so what
 * it runs is byte for byte what deploys.
 */

/** Rewrites extensionless paths to `/index.html` for client-side routing. */
export const SPA_REWRITE_CODE = `function handler(event) {
  var request = event.request;

  // Anything with a file extension is a real asset — let S3 answer it,
  // including answering 404 when it genuinely is missing.
  if (request.uri.indexOf('.') !== -1) {
    return request;
  }

  // Everything else is a client-side route: /settings, /products/123.
  request.uri = '/index.html';
  return request;
}`;

/** Overwrites `X-Forwarded-For` with the address CloudFront observed. */
export const VIEWER_IP_CODE = `function handler(event) {
  // Overwrite, never append: this makes the value unforgeable rather than
  // merely usually-correct, and the origin needs no trusted-proxy list to keep
  // current. event.viewer.ip is set by CloudFront and cannot be influenced by
  // the request.
  event.request.headers['x-forwarded-for'] = { value: event.viewer.ip };
  return event.request;
}`;
