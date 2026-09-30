import { describe, expect, it } from 'vitest';

import { DEV_MODE_HOURS, DEV_MODE_LOCAL_ONLY, localOrigin } from '../src/dev-mode.js';

/**
 * Development mode's rules (P4-19b): how long, and which origins can ever be
 * one. The widget's CORS check and the dashboard both ask `localOrigin`, so
 * this is the one list of what a development origin may be.
 */

describe('a development origin', () => {
  it.each([
    ['http://localhost:3000', 'http://localhost:3000'],
    ['localhost:5173', 'https://localhost:5173'],
    ['HTTP://LOCALHOST:8080/', 'http://localhost:8080'],
    ['http://shop.localhost:3000', 'http://shop.localhost:3000'],
  ])('admits %s as %s', (input, origin) => {
    expect(localOrigin(input)).toBe(origin);
  });

  it.each([
    'https://winery.com',
    'http://winery.com',
    'http://localhost.evil.com',
    'http://notlocalhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3000/path',
    'not an origin',
  ])('refuses %s', (input) => {
    /* A public name never becomes a development origin, however it is spelt:
     * no DNS proof ever stood behind it. */
    expect(localOrigin(input)).toBeUndefined();
  });
});

describe('the grant', () => {
  it('lasts a day', () => {
    expect(DEV_MODE_HOURS).toBe(24);
  });

  it('points a staging site at staging domains', () => {
    expect(DEV_MODE_LOCAL_ONLY).toMatch(/staging domain/u);
  });
});
