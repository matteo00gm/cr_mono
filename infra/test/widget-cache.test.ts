import { describe, expect, it } from 'vitest';

import {
  WIDGET_CONFIG_CACHE_KEY,
  WIDGET_CONFIG_MAX_AGE_SEC,
  WIDGET_CONFIG_PATH,
  widgetConfigCachePolicyArgs,
} from '../widget-cache.js';

/**
 * The edge cache for the widget's config (P2-10).
 *
 * Each figure fails silently when it is wrong. A cache key without `Origin`
 * serves one site's CORS echo to another; a key with a credential caches
 * nothing; a TTL longer than the API's own `max-age` holds a seller's edit
 * after the API has stopped saying so.
 */

describe('the widget config cache', () => {
  it('keys on the Origin and the public key, and on nothing a visitor carries', () => {
    expect(WIDGET_CONFIG_CACHE_KEY).toEqual({ headers: ['Origin'], queryStrings: ['key'] });

    const named = [...WIDGET_CONFIG_CACHE_KEY.headers].map((header) => header.toLowerCase());
    expect(named).not.toContain('authorization');
    expect(named).not.toContain('cookie');
  });

  it('holds a response for the minute the API promises, and no longer', () => {
    // The API's `Cache-Control: public, max-age=60` is asserted in
    // apps/api/test/widget-config.test.ts; the two numbers must agree.
    expect(WIDGET_CONFIG_MAX_AGE_SEC).toBe(60);
  });

  it('is the config path exactly, under the widget surface', () => {
    expect(WIDGET_CONFIG_PATH).toBe('/v1/widget/config');
    expect(WIDGET_CONFIG_PATH.includes('*')).toBe(false);
  });
});

describe('the cache policy cdn.ts creates (review fix)', () => {
  const args = widgetConfigCachePolicyArgs();

  it('never holds a response the API did not mark cacheable', () => {
    // Every refusal has no Cache-Control; a minimum above zero would cache it anyway.
    expect(args.minTtl).toBe(0);
  });

  it('holds a response for the minute the API promises, and no longer', () => {
    expect(args.defaultTtl).toBe(WIDGET_CONFIG_MAX_AGE_SEC);
    expect(args.maxTtl).toBe(WIDGET_CONFIG_MAX_AGE_SEC);
  });

  it('keys on exactly the Origin and the public key, and on no cookie', () => {
    const { cookiesConfig, headersConfig, queryStringsConfig } =
      args.parametersInCacheKeyAndForwardedToOrigin;

    expect(cookiesConfig).toEqual({ cookieBehavior: 'none' });
    expect(headersConfig).toEqual({ headerBehavior: 'whitelist', headers: { items: ['Origin'] } });
    expect(queryStringsConfig).toEqual({
      queryStringBehavior: 'whitelist',
      queryStrings: { items: ['key'] },
    });
  });
});
