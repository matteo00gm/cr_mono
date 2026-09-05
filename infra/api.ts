/// <reference path="../.sst/platform/config.d.ts" />

import process from 'node:process';

/**
 * The API Lambda and its Function URL (P0-54).
 *
 * One function serves both route surfaces (§5.1) — the split between
 * `/v1/dashboard/*` and `/v1/widget/*` is by route group inside Hono, not by
 * deployment. `/v1/widget/chat` is the single exception and gets its own
 * `RESPONSE_STREAM` function in P2-29, because invoke mode is a property of the
 * function rather than of the route.
 *
 * **Every option below is set explicitly, and three of them differ from SST's
 * default.** Verified against the pinned v4.17.1 source rather than the docs,
 * as `sst.config.ts` requires:
 *
 * | Option         | SST default (`function.ts`)         | Here      |
 * |----------------|-------------------------------------|-----------|
 * | `architecture` | `"x86_64"` (line 1769)              | `arm64`   |
 * | `runtime`      | `"nodejs24.x"` (line 1844)          | `nodejs22`|
 * | `memory`       | `"1024 MB"` (line 1888)             | `512 MB`  |
 *
 * Each of those defaults would have been wrong quietly. `x86_64` costs ~20%
 * more per GB-second for identical work; `1024 MB` doubles the figure every
 * cost projection in §5.2a is built from; and `nodejs24.x` would have run the
 * application on a runtime nothing in this repo has been tested against — the
 * `.nvmrc`, CI and every local run are all Node 22.
 */
export const api = new sst.aws.Function('Api', {
  handler: 'apps/api/src/index.handler',

  // Direct Function URL. CloudFront gains it as an origin in P0-17a, which
  // needs an origin to point at and is why that task waited for this one.
  url: true,

  architecture: 'arm64',
  runtime: 'nodejs22.x',
  memory: '512 MB',

  /**
   * BUFFERED, stated rather than inherited.
   *
   * `streaming: false` resolves to `invokeMode: "BUFFERED"` (function.ts:2744).
   * It is already the default, and it is written down anyway: flipping a
   * function to `RESPONSE_STREAM` changes the response envelope for *every*
   * route it serves and needs a different CloudFront cache behaviour to survive
   * the edge (P0-17a). A silent default change would surface as "the API
   * returns nothing", far from the line that caused it.
   */
  streaming: false,

  /**
   * 10 seconds, well under SST's 20-second default.
   *
   * Nothing on this function talks to a model — the endpoint that does is the
   * streaming one in P2-29, with its own timeout. What a long timeout buys here
   * is a request that has already failed continuing to bill, and a caller
   * holding a socket open on a database call that is never coming back.
   */
  timeout: '10 seconds',

  environment: {
    /**
     * The commit this bundle was built from, surfaced by `/v1/health`.
     *
     * Read from the CI environment at synth time, since neither SST nor Pulumi
     * knows about git. Empty on a local `sst deploy`, which the health endpoint
     * reports as `unknown` rather than failing — see `apps/api/src/app.ts`.
     */
    BUILD_SHA: process.env.GITHUB_SHA ?? '',
  },
});

/**
 * Not set here, deliberately: `concurrency`, `vpc`, and the SSM grants.
 *
 * - **Reserved concurrency** belongs to P1-48, which caps it at 10 rather than
 *   the 40 in §5.1 — each concurrent Lambda holds a Postgres connection, and 40
 *   against a `t4g.micro` is a self-inflicted outage. Leaving it unset now is
 *   safe only because nothing is deployed; P1-48 must land before real traffic.
 * - **VPC placement and the `database/url` grant** arrive with P0-45, the first
 *   task whose code actually opens a connection. Putting a function in private
 *   subnets before it needs to be there buys cold-start latency for nothing.
 */
export const apiUrl = api.url;
