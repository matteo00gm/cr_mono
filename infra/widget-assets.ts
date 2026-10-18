import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { contentTypeFor, IMMUTABLE } from './static-assets';

/**
 * How the widget's build becomes objects on the CDN (P3-01a).
 *
 * Pure, like `static-assets.ts`, so which file is cached for five minutes and
 * which for a year — and which is kept after the build that made it is gone —
 * is decided by a function with a test, not discovered on a storefront.
 *
 * **Three kinds of object, by what a seller's page asks for.**
 *
 * - `v1/w.js`, the loader at the address a seller pastes (`LOADER_SRC`). It
 *   cannot move, so it cannot be immutable: five minutes, which is how long a
 *   deploy takes to reach the next page view of every storefront.
 * - `v1/w-<hash>.js`, the same loader at an address of its own, for a seller
 *   who pins it with `integrity` (§1.1). Immutable, and **kept**: a pinned
 *   loader is a tag in somebody's theme that nobody here can edit.
 * - `v1/widget-<hash>.js`, the lazy bundle, named by its content in the build
 *   and imported by that name from the loader that was built with it.
 *   Immutable, and kept for the same reason: a pinned loader still names it.
 *
 * And `v1/integrity.json`, which says which pinned loader is current and what
 * its hash is, for the docs and for a seller who wants to pin it.
 */

/** Five minutes: a deploy reaches every storefront's next page view, and nothing older is fetched. */
export const LOADER_CACHE = 'public, max-age=300';

/** The address a seller pastes. `LOADER_SRC` in `packages/core` is this, on the production domain. */
export const LOADER_KEY = 'v1/w.js';

export const INTEGRITY_KEY = 'v1/integrity.json';

/**
 * The paths CloudFront sends to the bucket for these, **ahead of `/v1/*`**,
 * which would otherwise hand them to the API as JSON 404s (`behaviour-order.ts`).
 *
 * Each narrow enough to miss every API path: `/v1/w*` would take
 * `/v1/widget/config`, and `/v1/widget*` the chat. The test holds both.
 */
export const WIDGET_PATH_PATTERNS: readonly string[] = [
  '/v1/w.js',
  '/v1/w-*.js',
  '/v1/widget-*',
  '/v1/loader.js.map',
  '/v1/integrity.json',
];

export interface WidgetObject {
  /** The S3 key, under `v1/`. */
  readonly key: string;
  /** A file from the build, or a document written here. */
  readonly source: { readonly path: string } | { readonly content: string };
  readonly contentType: string;
  readonly cacheControl: string;
  /** SHA-256 of the bytes, so a redeploy notices a changed `w.js` (see `StaticAsset.hash`). */
  readonly hash: string;
  /** Left in the bucket when a later build no longer has it: something pinned may still name it. */
  readonly retain: boolean;
}

export interface WidgetPublication {
  readonly objects: readonly WidgetObject[];
  /** What a seller who pins the loader writes in the tag: its path on the CDN, and its hash. */
  readonly pinned: { readonly path: string; readonly integrity: string };
}

export class WidgetBuildError extends Error {
  constructor(directory: string, problem: string) {
    super(
      `The widget build at ${directory} ${problem}.\n\n` +
        '  Run `pnpm --filter @catalogorosso/widget build:bundle` before deploying. A deploy\n' +
        "  without it would leave the previous build's loader at the address every storefront\n" +
        '  loads, beside an API that has moved on (P3-01a).',
    );
    this.name = 'WidgetBuildError';
  }
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** The value of a `<script integrity>`: SHA-384, base64, as browsers check it. */
export const integrityOf = (bytes: Buffer): string =>
  `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

const WIDGET = /^widget-[A-Za-z0-9_-]{8,}\.js$/u;

/**
 * Every object the widget publishes, from the build directory.
 *
 * **Refuses a build it cannot publish whole**: no loader, or no widget, or two
 * widgets — a stale build beside a fresh one, and a loader that names only one
 * of them.
 */
export const widgetPublication = (directory: string): WidgetPublication => {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new WidgetBuildError(directory, 'does not exist');
  }

  const files = readdirSync(directory);

  if (!files.includes('loader.js')) throw new WidgetBuildError(directory, 'has no loader.js');

  const widgets = files.filter((file) => WIDGET.test(file));

  if (widgets.length !== 1) {
    throw new WidgetBuildError(
      directory,
      widgets.length === 0
        ? 'has no widget-<hash>.js'
        : `has ${String(widgets.length)} widgets (${widgets.join(', ')}); rebuild into an empty directory`,
    );
  }

  const loaderPath = join(directory, 'loader.js');
  const loader = readFileSync(loaderPath);
  const pinnedKey = `v1/w-${sha256(loader).slice(0, 16)}.js`;
  const integrity = integrityOf(loader);

  const file = (
    key: string,
    path: string,
    cacheControl: string,
    retain: boolean,
  ): WidgetObject => ({
    key,
    source: { path },
    contentType: contentTypeFor(key),
    cacheControl,
    hash: sha256(readFileSync(path)),
    retain,
  });

  /* The lazy bundle and its map, then the pinned loader: kept, because something may name them. */
  const kept = [...widgets, ...widgets.map((widget) => `${widget}.map`)]
    .filter((name) => files.includes(name))
    .map((name) => file(`v1/${name}`, join(directory, name), IMMUTABLE, true));

  const document = `${JSON.stringify({ path: `/${pinnedKey}`, integrity }, null, 2)}\n`;

  return {
    objects: [
      ...kept,
      file(pinnedKey, loaderPath, IMMUTABLE, true),
      /* The address every storefront loads, and what says which pinned one is current. */
      file(LOADER_KEY, loaderPath, LOADER_CACHE, false),
      ...(files.includes('loader.js.map')
        ? [file('v1/loader.js.map', join(directory, 'loader.js.map'), LOADER_CACHE, false)]
        : []),
      {
        key: INTEGRITY_KEY,
        source: { content: document },
        contentType: contentTypeFor(INTEGRITY_KEY),
        cacheControl: LOADER_CACHE,
        hash: sha256(document),
        retain: false,
      },
    ],
    pinned: { path: `/${pinnedKey}`, integrity },
  };
};
