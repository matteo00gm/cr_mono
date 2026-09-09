import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

/**
 * How a built SPA is turned into S3 objects (P0-58).
 *
 * **Separate from `infra/dashboard.ts`, and that is what makes it testable.**
 * Nothing here touches `sst`, `aws` or the `$app` globals, so the decision that
 * actually matters — which files may be cached for a year and which must never
 * be — is a pure function with a unit test, rather than a property discovered
 * after a deploy served a stale shell to everybody.
 *
 * `pnpm typecheck:infra` is local-only (E3), so a test is worth more here than
 * anywhere else in `infra/`.
 */

/**
 * The two headers, and the reason getting them backwards is the classic SPA
 * deployment bug.
 *
 * `index.html` names the hashed bundles. Cache it, and a browser keeps asking
 * for the *old* bundle names after a deploy — which S3 still has, so nothing
 * 404s and nothing looks broken; the console simply stays on the previous
 * version until the cache expires. Cache the bundles for a year and they may:
 * their names change on every build, so a stale name is never requested twice.
 *
 * The consequences are asymmetric, and that decides the default below. A file
 * wrongly marked `immutable` is cached for a year in browsers nobody can reach
 * — there is no invalidation for a client-side cache, only a new URL. A file
 * wrongly marked `no-cache` costs one conditional request.
 */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';

/**
 * Vite writes `assets/<name>-<hash><ext>`, and the hash is what makes a URL
 * safe to freeze. Eight or more base64url-ish characters between the last `-`
 * and the extension, which is Vite's default width and then some.
 *
 * Deliberately narrow. Matching anything under `assets/` would freeze a file
 * somebody dropped there by hand — `assets/logo.svg` is not content-addressed,
 * and a year is a long time to serve the wrong one.
 */
const HASHED = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+(\.map)?$/;

/**
 * Immutable only when the name carries a hash; everything else revalidates.
 *
 * **Opt-in rather than opt-out**, which is the whole point: a new kind of file
 * appearing in the build output gets the safe treatment without anybody
 * remembering to add a rule for it.
 */
export const cacheControlFor = (key: string): string =>
  key.startsWith('assets/') && HASHED.test(key) ? IMMUTABLE : REVALIDATE;

/**
 * Content types, by extension.
 *
 * S3 defaults an unknown object to `binary/octet-stream`, which a browser
 * downloads instead of rendering — so an unmapped extension is a page that
 * silently offers itself as a file. Hence the explicit fallback below and the
 * test that names it.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  map: 'application/json; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
};

export const contentTypeFor = (key: string): string => {
  const extension = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
};

export interface StaticAsset {
  /** The S3 key: the path under the build directory, with forward slashes. */
  readonly key: string;
  /** The absolute path on disk, for the upload. */
  readonly path: string;
  readonly contentType: string;
  readonly cacheControl: string;
  /**
   * SHA-256 of the file's contents.
   *
   * **This is what makes a redeploy notice a changed file.** Pulumi compares a
   * resource's declared *inputs*, and the input for a file upload is a path —
   * which does not change when the bytes behind it do. Without a content hash,
   * a deploy reports no changes and keeps serving the previous build, which is
   * indistinguishable from a deploy that worked.
   *
   * It matters for exactly one file in practice. Hashed assets get a new key on
   * every build and are therefore new objects anyway; `index.html` is the one
   * whose name never changes, and it is also the file that names all the
   * others.
   */
  readonly hash: string;
}

export class MissingBuildError extends Error {
  constructor(directory: string) {
    super(
      `The dashboard build output is not at ${directory}.\n\n` +
        '  Run `pnpm --filter @catalogorosso/dashboard build` before deploying. This is a\n' +
        '  synth-time failure on purpose: deploying without it would leave the previous\n' +
        "  build's files in the bucket while the API moved on, and a console running\n" +
        '  against an API it was not built for fails in ways nobody can reproduce (P0-58).',
    );
    this.name = 'MissingBuildError';
  }
}

/**
 * Every file under `directory`, as S3 keys with their headers already decided.
 *
 * Reads the tree rather than taking a list, because a build output is whatever
 * the bundler emitted — a hand-maintained manifest is a second source of truth
 * that goes stale the first time a chunk splits, and the symptom is a missing
 * asset in production.
 */
export const collectAssets = (directory: string): readonly StaticAsset[] => {
  let entries: readonly string[];
  try {
    entries = readdirSync(directory);
  } catch {
    throw new MissingBuildError(directory);
  }

  const assets: StaticAsset[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const absolute = join(current, entry);

      if (statSync(absolute).isDirectory()) {
        walk(absolute);
        continue;
      }

      // POSIX separators, always: an S3 key built on Windows would otherwise
      // carry backslashes and every asset would 404 in production while the
      // deploy reported success.
      const key = relative(directory, absolute).split(sep).join(posix.sep);

      assets.push({
        key,
        path: absolute,
        contentType: contentTypeFor(key),
        cacheControl: cacheControlFor(key),
        /*
         * Base64 rather than the `Buffer` itself, and this is a typing
         * concession rather than a preference: `tsconfig.sst.json` sets
         * `"types": []`, so the `Buffer` in scope here comes from SST's
         * vendored platform typings and does not satisfy `BinaryLike`. Hashing
         * an injective encoding of the bytes identifies the content exactly as
         * well, and the value is only ever compared with itself.
         */
        hash: createHash('sha256').update(readFileSync(absolute).toString('base64')).digest('hex'),
      });
    }
  };

  walk(directory);

  /*
   * An empty directory is the same failure as a missing one and must not be
   * quieter. `vite build` into a fresh tree that then fails leaves exactly
   * this, and uploading nothing would take the console down while every
   * resource in the stack reported success.
   */
  if (assets.length === 0 || !assets.some((asset) => asset.key === 'index.html')) {
    throw new MissingBuildError(`${directory} (found ${entries.length} entries, no index.html)`);
  }

  return assets;
};
