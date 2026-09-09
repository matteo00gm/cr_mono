import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cacheControlFor,
  collectAssets,
  contentTypeFor,
  IMMUTABLE,
  MissingBuildError,
  REVALIDATE,
} from '../static-assets.js';

/**
 * The static-asset decisions (P0-58).
 *
 * **The only tested file in `infra/`, and deliberately the one worth testing.**
 * Everything else here is resource declarations whose behaviour is AWS's;
 * this is a decision with a wrong answer that ships silently. `pnpm
 * typecheck:infra` is local-only (E3), so `infra/` is otherwise guarded by CI
 * greps — which can check that a string appears, and not that it appears on the
 * right file.
 *
 * The row's own test is a post-deploy smoke check. This is what can be asserted
 * without a deploy, and it covers the half that is a judgement rather than a
 * fact about CloudFront.
 */

const temporary: string[] = [];

const buildTree = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), 'sommelier-dist-'));
  temporary.push(root);

  for (const [key, contents] of Object.entries(files)) {
    const absolute = join(root, ...key.split('/'));
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }

  return root;
};

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('cacheControlFor', () => {
  it('never caches the shell, because it names the hashed bundles', () => {
    /*
     * The classic SPA deployment bug, in one assertion. A cached `index.html`
     * keeps asking for the *previous* bundle names — which S3 still has, so
     * nothing 404s and nothing looks broken; the console simply stays on the
     * old version until the cache expires.
     */
    expect(cacheControlFor('index.html')).toBe(REVALIDATE);
  });

  it('freezes a hashed bundle for a year', () => {
    expect(cacheControlFor('assets/index-ENiHflsc.js')).toBe(IMMUTABLE);
    expect(cacheControlFor('assets/index-CCsU677f.css')).toBe(IMMUTABLE);
    expect(cacheControlFor('assets/index-ENiHflsc.js.map')).toBe(IMMUTABLE);
  });

  it('does not freeze an unhashed file that happens to live under assets/', () => {
    /*
     * The reason the hash pattern is narrow rather than "anything under
     * assets/". A logo dropped in by hand is not content-addressed, and a year
     * is a long time to serve the wrong one — there is no invalidation for a
     * browser cache, only a new URL.
     */
    expect(cacheControlFor('assets/logo.svg')).toBe(REVALIDATE);
    expect(cacheControlFor('assets/robots.txt')).toBe(REVALIDATE);
  });

  it('does not freeze a hashed-looking name outside assets/', () => {
    expect(cacheControlFor('index-ENiHflsc.html')).toBe(REVALIDATE);
  });

  it('defaults an unfamiliar file to revalidating', () => {
    /*
     * Opt-in rather than opt-out, which is the whole design: a new kind of
     * output — a manifest, a service worker, a `.well-known` file — gets the
     * safe treatment without anybody remembering to add a rule. A service
     * worker in particular is the file where an accidental year of caching is
     * unrecoverable without a code change users cannot receive.
     */
    expect(cacheControlFor('sw.js')).toBe(REVALIDATE);
    expect(cacheControlFor('manifest.webmanifest')).toBe(REVALIDATE);
    expect(cacheControlFor('.well-known/apple-app-site-association')).toBe(REVALIDATE);
  });
});

describe('contentTypeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['assets/index-abcdefgh.js', 'text/javascript; charset=utf-8'],
    ['assets/index-abcdefgh.css', 'text/css; charset=utf-8'],
    ['assets/index-abcdefgh.js.map', 'application/json; charset=utf-8'],
    ['icon.svg', 'image/svg+xml'],
    ['font.woff2', 'font/woff2'],
  ])('types %s', (key, expected) => {
    expect(contentTypeFor(key)).toBe(expected);
  });

  it('is case-insensitive about the extension', () => {
    expect(contentTypeFor('LOGO.PNG')).toBe('image/png');
  });

  it('falls back rather than guessing', () => {
    /*
     * S3 defaults an unknown object to `binary/octet-stream`, and a browser
     * downloads that instead of rendering it — so an unmapped extension is a
     * page that silently offers itself as a file. The fallback is explicit so
     * the behaviour is ours rather than the bucket's.
     */
    expect(contentTypeFor('data.bin')).toBe('application/octet-stream');
    expect(contentTypeFor('LICENSE')).toBe('application/octet-stream');
  });
});

describe('collectAssets', () => {
  it('walks the tree and decides every file', () => {
    const root = buildTree({
      'index.html': '<!doctype html>',
      'assets/index-ENiHflsc.js': 'console.log(1)',
      'assets/index-CCsU677f.css': 'body{}',
    });

    const assets = [...collectAssets(root)].sort((a, b) => a.key.localeCompare(b.key));

    expect(assets.map((asset) => asset.key)).toEqual([
      'assets/index-CCsU677f.css',
      'assets/index-ENiHflsc.js',
      'index.html',
    ]);
    expect(assets.map((asset) => asset.cacheControl)).toEqual([IMMUTABLE, IMMUTABLE, REVALIDATE]);
  });

  it('writes keys with forward slashes whatever the platform uses', () => {
    /*
     * The bug this exists to prevent is invisible on the machine that produced
     * it. An S3 key built on Windows carries backslashes, so every nested asset
     * 404s in production while the deploy reports complete success — and the
     * developer who deployed it cannot reproduce the failure locally.
     */
    const root = buildTree({ 'index.html': 'x', 'assets/deep/index-abcdefgh.js': 'y' });

    for (const asset of collectAssets(root)) {
      expect(asset.key).not.toContain('\\');
    }
  });

  it('gives each file a content hash, so a redeploy sees a changed shell', () => {
    /*
     * Without this a deploy compares the only other input — the path — finds it
     * unchanged, and keeps serving the previous build while reporting success.
     * `index.html` is the file it matters for: hashed assets get new keys and
     * are therefore new objects anyway.
     */
    const before = collectAssets(buildTree({ 'index.html': 'version one' }));
    const after = collectAssets(buildTree({ 'index.html': 'version two' }));

    expect(before[0]?.hash).not.toBe(after[0]?.hash);
  });

  it('refuses a directory that does not exist', () => {
    expect(() => collectAssets(join(tmpdir(), 'sommelier-not-built-at-all'))).toThrow(
      MissingBuildError,
    );
  });

  it('refuses a build with no index.html, which is the quiet version', () => {
    /*
     * `vite build` into a fresh tree that then fails leaves exactly this.
     * Uploading whatever was there would take the console down while every
     * resource in the stack reported success — so it is a synth failure, which
     * is the loudest place left to put it.
     */
    expect(() => collectAssets(buildTree({ 'assets/index-abcdefgh.js': 'orphan' }))).toThrow(
      MissingBuildError,
    );
  });

  it('names the directory it looked in, because the usual cause is the wrong one', () => {
    const missing = join(tmpdir(), 'sommelier-nowhere');

    expect(() => collectAssets(missing)).toThrow(missing);
  });
});
