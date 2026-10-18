import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { patternMatches, shadowedBehaviours } from '../behaviour-order.js';
import { IMMUTABLE } from '../static-assets.js';
import {
  INTEGRITY_KEY,
  integrityOf,
  LOADER_CACHE,
  LOADER_KEY,
  WIDGET_PATH_PATTERNS,
  WidgetBuildError,
  widgetPublication,
  type WidgetObject,
} from '../widget-assets.js';
import { WIDGET_CONFIG_PATH } from '../widget-cache.js';

/**
 * The widget on the CDN, decided without a deploy (P3-01a): which object goes
 * where, for how long, which is kept when its build is gone, and that the
 * paths CloudFront sends to the bucket are the widget's and no API's.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WIDGET = 'widget-uIbylzyi.js';

const build = (files: Readonly<Record<string, string>>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'widget-bundle-'));

  temporary.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);

  return dir;
};

const complete = () =>
  build({
    'loader.js': 'abc',
    'loader.js.map': '{}',
    [WIDGET]: 'export const mountPanel = () => {};',
    [`${WIDGET}.map`]: '{}',
  });

const byKey = (objects: readonly WidgetObject[]) =>
  Object.fromEntries(objects.map((object) => [object.key, object]));

describe('the integrity of a script', () => {
  it('is SHA-384 in base64, as a browser checks it', () => {
    /* FIPS 180-2's own test vector for "abc". */
    expect(integrityOf(Buffer.from('abc'))).toBe(
      'sha384-ywB1P0WjXou1oD1pmsZQBycsMqsO3tFjGotgWkP/W+2AhgcroefMI1i67KE0yCWn',
    );
  });
});

describe('what a build publishes', () => {
  it('is the loader at the pasted address for five minutes, and everything named by content for a year, kept', () => {
    const publication = widgetPublication(complete());
    const objects = byKey(publication.objects);
    const pinned = publication.pinned.path.slice(1);

    expect(Object.keys(objects).sort()).toEqual(
      [
        LOADER_KEY,
        'v1/loader.js.map',
        pinned,
        `v1/${WIDGET}`,
        `v1/${WIDGET}.map`,
        INTEGRITY_KEY,
      ].sort(),
    );

    expect(objects[LOADER_KEY]).toMatchObject({ cacheControl: LOADER_CACHE, retain: false });
    expect(objects['v1/loader.js.map']).toMatchObject({
      cacheControl: LOADER_CACHE,
      retain: false,
    });
    expect(objects[INTEGRITY_KEY]).toMatchObject({ cacheControl: LOADER_CACHE, retain: false });

    for (const key of [pinned, `v1/${WIDGET}`, `v1/${WIDGET}.map`]) {
      expect(objects[key], key).toMatchObject({ cacheControl: IMMUTABLE, retain: true });
    }
  });

  it('holds the pasted address for minutes, never a year: it cannot move, so only a short cache lets it change', () => {
    const maxAge = Number(/max-age=(\d+)/u.exec(LOADER_CACHE)?.[1]);

    expect(LOADER_CACHE).not.toContain('immutable');
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(600);
  });

  it('serves the scripts as JavaScript, which a module script refuses to run otherwise', () => {
    const objects = byKey(widgetPublication(complete()).objects);

    expect(objects[LOADER_KEY]?.contentType).toMatch(/^text\/javascript/u);
    expect(objects[`v1/${WIDGET}`]?.contentType).toMatch(/^text\/javascript/u);
    expect(objects[INTEGRITY_KEY]?.contentType).toMatch(/^application\/json/u);
  });

  it('pins the loader by its content, at an address of its own, under the hash it publishes', () => {
    const dir = complete();
    const publication = widgetPublication(dir);
    const digest = createHash('sha256').update('abc').digest('hex').slice(0, 16);

    expect(publication.pinned).toEqual({
      path: `/v1/w-${digest}.js`,
      integrity: integrityOf(Buffer.from('abc')),
    });

    const objects = byKey(publication.objects);

    /* The same file as the pasted address, so what is pinned is what everybody else runs. */
    expect(objects[`v1/w-${digest}.js`]?.source).toEqual({ path: join(dir, 'loader.js') });
    expect(objects[LOADER_KEY]?.source).toEqual({ path: join(dir, 'loader.js') });

    const document = objects[INTEGRITY_KEY]?.source;

    expect(document !== undefined && 'content' in document && JSON.parse(document.content)).toEqual(
      publication.pinned,
    );
  });

  it('gives a changed loader a new pinned address, and the same loader the same one', () => {
    const first = widgetPublication(complete()).pinned;
    const again = widgetPublication(complete()).pinned;
    const changed = widgetPublication(build({ 'loader.js': 'abd', [WIDGET]: 'export {}' })).pinned;

    expect(again).toEqual(first);
    expect(changed.path).not.toBe(first.path);
    expect(changed.integrity).not.toBe(first.integrity);
  });

  it('hashes every object’s bytes, so a redeploy notices a changed w.js at the same key', () => {
    /*
     * One directory, rebuilt in place, as a deploy sees it: the path is the
     * same both times, so only the bytes can tell the two builds apart.
     */
    const dir = complete();
    const before = byKey(widgetPublication(dir).objects)[LOADER_KEY]?.hash;

    writeFileSync(join(dir, 'loader.js'), 'abd');

    const after = byKey(widgetPublication(dir).objects)[LOADER_KEY]?.hash;

    expect(before).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(after).not.toBe(before);
  });

  it('publishes no map it was not given', () => {
    const keys = widgetPublication(
      build({ 'loader.js': 'abc', [WIDGET]: 'export {}' }),
    ).objects.map(({ key }) => key);

    expect(keys.some((key) => key.endsWith('.map'))).toBe(false);
  });
});

describe('a build that cannot be published whole', () => {
  it.each([
    ['no build at all', () => join(tmpdir(), 'no-such-widget-build'), /does not exist/u],
    ['no loader', () => build({ [WIDGET]: 'export {}' }), /has no loader\.js/u],
    ['no widget', () => build({ 'loader.js': 'abc' }), /has no widget-<hash>\.js/u],
    [
      'a widget under a fixed name, which a cached loader would fetch a new one under',
      () => build({ 'loader.js': 'abc', 'widget.js': 'export {}' }),
      /has no widget-<hash>\.js/u,
    ],
    [
      'two widgets, a stale build beside a fresh one',
      () =>
        build({ 'loader.js': 'abc', [WIDGET]: 'export {}', 'widget-0ld0ld0ld.js': 'export {}' }),
      /has 2 widgets/u,
    ],
  ])('is refused: %s', (_, directory, problem) => {
    expect(() => widgetPublication(directory())).toThrow(WidgetBuildError);
    expect(() => widgetPublication(directory())).toThrow(problem);
  });

  it('says how to build it', () => {
    expect(() => widgetPublication(build({}))).toThrow(/build:bundle/u);
  });
});

describe('the paths CloudFront sends to the bucket', () => {
  it('take every key a build publishes', () => {
    for (const { key } of widgetPublication(complete()).objects) {
      expect(
        WIDGET_PATH_PATTERNS.some((pattern) => patternMatches(pattern, `/${key}`)),
        key,
      ).toBe(true);
    }
  });

  it('take no path of the API’s, which a wider pattern would hand to S3 as a 403', () => {
    const api = [
      '/v1/health',
      WIDGET_CONFIG_PATH,
      '/v1/widget/session',
      '/v1/widget/chat',
      '/v1/widget/events',
      '/v1/widget/turnstile',
      '/v1/dashboard/me',
      '/v1/webhooks/stripe',
      '/v1/webhooks/shopify',
      '/v1/checkout/sessions',
      '/v1/prices',
    ];

    for (const path of api) {
      expect(
        WIDGET_PATH_PATTERNS.filter((pattern) => patternMatches(pattern, path)),
        path,
      ).toEqual([]);
    }
  });

  it('come before the API’s, and are each reachable, in the order cdn.ts gives them', () => {
    expect(
      shadowedBehaviours([...WIDGET_PATH_PATTERNS, '/v1/widget/chat', WIDGET_CONFIG_PATH, '/v1/*']),
    ).toEqual([]);
    /* Behind `/v1/*`, every one of them would be the API's. */
    expect(
      shadowedBehaviours(['/v1/*', ...WIDGET_PATH_PATTERNS]).map(({ pattern }) => pattern),
    ).toEqual(WIDGET_PATH_PATTERNS);
  });
});
