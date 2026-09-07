/// <reference path="../.sst/platform/config.d.ts" />

import process from 'node:process';
import { join } from 'node:path';

import { dashboardBucket, distribution } from './cdn';
import { collectAssets } from './static-assets';

/**
 * The dashboard SPA on S3, behind the P0-17 distribution (P0-58).
 *
 * **Not `sst.aws.StaticSite`, which is what the row names.** That component
 * brings its own bucket *and* its own CloudFront distribution, and this
 * application already has one built by hand — with a per-behaviour SPA-rewrite
 * function, an API origin carrying the A2 secret, and the ordering warning
 * P3 depends on (`infra/cdn.ts`). Adopting `StaticSite` would mean either a
 * second distribution on a second domain, which breaks the same-origin session
 * cookie the whole auth design rests on, or unpicking P0-17a. Uploading objects
 * into the bucket that already exists is the smaller thing by a wide margin.
 *
 * What that costs is stated rather than hidden: the cache headers, the content
 * types and the "did anything get built" check are ours to get right instead of
 * the component's. All three live in `static-assets.ts` with a unit test, which
 * is more than `typecheck:infra` could have given them anyway (E3).
 */

/**
 * Resolved from the working directory, and asserted rather than assumed.
 *
 * `sst deploy` is documented as running from the project root and every path in
 * this tree already relies on that — `handler: 'apps/api/src/index.handler'`,
 * `copyFiles: { from: 'packages/db/bootstrap' }`. The difference here is that a
 * wrong root would produce a *quiet* failure, so `collectAssets` throws with
 * the path it looked in rather than uploading an empty set.
 */
const BUILD_DIRECTORY = join(process.cwd(), 'apps', 'dashboard', 'dist');

/**
 * The API URL is **not** injected at build time, and the row's instruction to
 * do so no longer applies.
 *
 * P0-17a put the SPA and the API on one distribution, so `/v1/...` is
 * same-origin and `apps/dashboard/src/session.ts` addresses it with a relative
 * path. Injecting an absolute URL would create a second source of truth for the
 * origin, and the failure when they disagree is a cross-origin request that
 * drops the session cookie — a login that appears to succeed and then behaves
 * as though it did not.
 *
 * That same-origin arrangement is also what makes `Secure; SameSite=Lax`
 * workable at all (D5), so this is not a saving to reverse casually.
 */
const assets = collectAssets(BUILD_DIRECTORY);

/**
 * A Pulumi logical name, which is not the S3 key.
 *
 * Names live in the state file and are matched across deploys, so a `/` or a
 * `.` in one is at best noise in a URN. The keys are unique, so the sanitised
 * forms are too.
 *
 * **A hashed asset gets a new name on every build, and that is intended.**
 * Pulumi then creates the new object and deletes the old one, which is how
 * stale bundles leave the bucket instead of accumulating forever. The window
 * where a browser holding the previous `index.html` could ask for a just-deleted
 * chunk is real but empty here: the build emits one bundle and no lazy chunks,
 * so nothing is fetched after the shell. That changes the day a route is
 * code-split, and then this wants a retention pass rather than a delete.
 */
const logicalName = (key: string) => `DashboardAsset-${key.replace(/[^A-Za-z0-9]+/g, '-')}`;

export const dashboardObjects = assets.map(
  (asset) =>
    new aws.s3.BucketObjectv2(logicalName(asset.key), {
      bucket: dashboardBucket.id,
      key: asset.key,
      source: new $util.asset.FileAsset(asset.path),

      // See `StaticAsset.hash`: without a content hash a changed `index.html`
      // is invisible to a redeploy, because its path — the only other input —
      // is the same as it was.
      sourceHash: asset.hash,

      contentType: asset.contentType,
      cacheControl: asset.cacheControl,
    }),
);

/**
 * No invalidation, and that is a decision rather than an omission.
 *
 * The default behaviour in `infra/cdn.ts` uses the legacy TTL fields with
 * `minTtl: 0`, so CloudFront honours an origin `Cache-Control` — and
 * `index.html` is uploaded with `no-cache`, which makes the edge revalidate
 * against S3 on every request and pick up a new shell immediately. Hashed
 * assets never need invalidating because their keys change.
 *
 * An invalidation would therefore be belt over a working brace, and it is not
 * free: CloudFront invalidations are billed past the first thousand paths a
 * month and are the usual reason a `/*` in a deploy script quietly becomes a
 * line item. If the cache policy on that behaviour is ever changed to ignore
 * origin headers, this stops being true — which is the thing to remember, and
 * the reason it is written down here rather than left as silence.
 */
export const dashboardUrl = $interpolate`https://${distribution.domainName}`;
