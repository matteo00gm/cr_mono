/// <reference path="../.sst/platform/config.d.ts" />

import process from 'node:process';
import { join } from 'node:path';

import { dashboardBucket } from './cdn';
import { widgetPublication, type WidgetObject } from './widget-assets';

/**
 * The widget on the CDN (P3-01a): what a storefront's `<script>` loads.
 *
 * **In the dashboard's bucket, under `v1/`**, behind the same distribution and
 * the same origin access control. A second bucket would be a second policy and a
 * second origin for four files, and the keys cannot collide: the dashboard's are
 * `index.html` and `assets/`. CloudFront's widget behaviours (`cdn.ts`) are what
 * send `/v1/w.js` here rather than to the API.
 *
 * What goes up, and for how long, is `widget-assets.ts`'s, with its test.
 */

/** Asserted rather than assumed, as the dashboard's is: a wrong root throws with the path. */
const BUILD_DIRECTORY = join(process.cwd(), 'apps', 'widget', 'dist', 'bundle');

const publication = widgetPublication(BUILD_DIRECTORY);

/** A Pulumi logical name, which is not the S3 key (see `infra/dashboard.ts`). */
const logicalName = (key: string) => `WidgetAsset-${key.replace(/[^A-Za-z0-9]+/g, '-')}`;

const upload = (object: WidgetObject, dependsOn: $util.Resource[] = []) =>
  new aws.s3.BucketObjectv2(
    logicalName(object.key),
    {
      bucket: dashboardBucket.id,
      key: object.key,
      ...('path' in object.source
        ? { source: new $util.asset.FileAsset(object.source.path) }
        : { content: object.source.content }),
      sourceHash: object.hash,
      contentType: object.contentType,
      cacheControl: object.cacheControl,
    },
    {
      /*
       * **Kept when it leaves the build.** Pulumi deletes a resource that
       * disappears from the program, and a widget bundle disappears on the next
       * build — while a pinned loader in some seller's theme still imports it.
       * Retained, it stays in the bucket and leaves the state. They are a few
       * dozen kilobytes each; the bucket outgrows nothing.
       */
      retainOnDelete: object.retain,
      dependsOn,
    },
  );

/*
 * **The bundles first, then the address that names them.** Uploaded in
 * parallel, a new `w.js` could be live for a moment before the widget it
 * imports exists — and every visitor who clicked in that moment would get a
 * launcher that never opens.
 */
export const widgetBundles = publication.objects
  .filter((object) => object.retain)
  .map((object) => upload(object));

export const widgetLoader = publication.objects
  .filter((object) => !object.retain)
  .map((object) => upload(object, widgetBundles));

/** What a seller pins, for the outputs of a deploy: the docs show it with the API's own domain. */
export const widgetPinned = publication.pinned;
