import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkedBehaviourOrder, shadowedBehaviours } from '../behaviour-order.js';
import { WIDGET_CONFIG_PATH } from '../widget-cache.js';

/**
 * CloudFront behaviour order (review fix).
 *
 * CloudFront routes a request by the first behaviour whose pattern matches, so
 * an order mistake fails quietly: the API still answers, just through the wrong
 * behaviour. These cases are the mistakes this distribution has already had to
 * avoid in comments — the config cache, and P3's widget bundles.
 */

describe('shadowedBehaviours', () => {
  it('passes the API behaviours in the order cdn.ts gives them', () => {
    expect(shadowedBehaviours(['/v1/widget/chat', WIDGET_CONFIG_PATH, '/v1/*'])).toEqual([]);
  });

  it('names a specific path placed after the wildcard that takes its requests', () => {
    expect(shadowedBehaviours(['/v1/widget/chat', '/v1/*', WIDGET_CONFIG_PATH])).toEqual([
      { pattern: WIDGET_CONFIG_PATH, shadowedBy: '/v1/*' },
    ]);
  });

  it('catches a later wildcard that an earlier one already covers', () => {
    // P3's bundles appended after `/v1/*` would be served by the API Lambda as JSON 404s.
    expect(shadowedBehaviours(['/v1/*', '/v1/widget-*.js'])).toEqual([
      { pattern: '/v1/widget-*.js', shadowedBy: '/v1/*' },
    ]);
  });

  it('reads ? as one character and everything else literally, case included', () => {
    expect(shadowedBehaviours(['/v1/w?.js', '/v1/wx.js'])).toEqual([
      { pattern: '/v1/wx.js', shadowedBy: '/v1/w?.js' },
    ]);
    // Exactly one: `?` does not stretch over two characters the way `*` does.
    expect(shadowedBehaviours(['/v1/w?.js', '/v1/wxy.js'])).toEqual([]);
    // The dot is a dot, not "any character".
    expect(shadowedBehaviours(['/v1/a.js', '/v1/abjs'])).toEqual([]);
    expect(shadowedBehaviours(['/V1/*', WIDGET_CONFIG_PATH])).toEqual([]);
  });

  it('flags a pattern listed twice, since the second can never apply', () => {
    expect(shadowedBehaviours(['/v1/*', '/v1/*'])).toEqual([
      { pattern: '/v1/*', shadowedBy: '/v1/*' },
    ]);
  });
});

describe('checkedBehaviourOrder', () => {
  it('hands back the behaviours it was given when every one is reachable', () => {
    const behaviours = [{ pathPattern: WIDGET_CONFIG_PATH }, { pathPattern: '/v1/*' }];

    expect(checkedBehaviourOrder(behaviours)).toBe(behaviours);
  });

  it('refuses an unreachable behaviour, naming it and the pattern in its way', () => {
    expect(() =>
      checkedBehaviourOrder([{ pathPattern: '/v1/*' }, { pathPattern: WIDGET_CONFIG_PATH }]),
    ).toThrow(`${WIDGET_CONFIG_PATH} is matched first by /v1/*`);
  });
});

describe('cdn.ts', () => {
  /*
   * `cdn.ts` builds AWS resources at import and cannot be loaded here, so the
   * wiring is read from its source. Blunt, and still the only thing that fails
   * if somebody unwraps the check or inlines the policy again.
   */
  const source = readFileSync(fileURLToPath(new URL('../cdn.ts', import.meta.url)), 'utf8');

  it('checks its own ordered behaviours when it is synthesised', () => {
    expect(source).toContain('orderedCacheBehaviors: checkedBehaviourOrder([');
  });

  it('creates the widget config cache from the arguments widget-cache.ts tests', () => {
    expect(source).toMatch(
      /new aws\.cloudfront\.CachePolicy\(\s*'WidgetConfigCache',\s*widgetConfigCachePolicyArgs\(\),\s*\)/,
    );
  });
});
