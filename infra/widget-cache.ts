/**
 * The edge cache for `GET /v1/widget/config` (P2-10).
 *
 * **Separate from `cdn.ts` for the reason `edge-functions.ts` is**: that module
 * constructs SST resources at import and cannot be loaded outside a deploy, so
 * the decisions in it are not testable there.
 *
 * Config is fetched on every page view of every seller's shop, before a visitor
 * has done anything (§1.2), and it changes when a seller edits their widget. A
 * minute at the edge absorbs the page views and still shows an edit within a
 * minute — and nothing in the response is private, which is the only reason it
 * may be cached publicly at all.
 */

/** The one path this cache policy is for. More specific than `/v1/*`, so it must come first. */
export const WIDGET_CONFIG_PATH = '/v1/widget/config';

/**
 * One minute, at the edge and in the browser.
 *
 * The API sends `Cache-Control: public, max-age=60` on a 200, and the policy's
 * maximum is the same number, so neither side can hold a response longer than
 * the other intends. A refusal carries no such header and is never cached.
 */
export const WIDGET_CONFIG_MAX_AGE_SEC = 60;

/**
 * What a cached response is keyed on, and nothing else.
 *
 * **`Origin` because the response is per origin**: its CORS headers echo one
 * site, and a response cached for `https://a.example` served to
 * `https://b.example` is the multi-tenancy bug `Vary: Origin` exists to prevent
 * (§3.1). **`key` because the response is per tenant.** No cookie and no
 * `Authorization` — the widget surface accepts no credentials, and keying on one
 * would split the cache per visitor and cache nothing.
 */
export const WIDGET_CONFIG_CACHE_KEY = {
  headers: ['Origin'],
  queryStrings: ['key'],
} as const;

/**
 * The cache policy exactly as `cdn.ts` hands it to CloudFront (review fix).
 *
 * Built here rather than inline, so the figures a test reads are the figures
 * the distribution gets. Before, the test checked the constants above and
 * `cdn.ts` could have wired them into the wrong fields — a `minTtl` of sixty
 * holds every refusal for a minute — with that test still green.
 */
export const widgetConfigCachePolicyArgs = () => ({
  comment: 'GET /v1/widget/config, keyed on Origin and the public key (P2-10)',
  /** Zero, so a response without `Cache-Control` — every refusal — is never held. */
  minTtl: 0,
  defaultTtl: WIDGET_CONFIG_MAX_AGE_SEC,
  maxTtl: WIDGET_CONFIG_MAX_AGE_SEC,
  parametersInCacheKeyAndForwardedToOrigin: {
    cookiesConfig: { cookieBehavior: 'none' },
    headersConfig: {
      headerBehavior: 'whitelist',
      headers: { items: [...WIDGET_CONFIG_CACHE_KEY.headers] },
    },
    queryStringsConfig: {
      queryStringBehavior: 'whitelist',
      queryStrings: { items: [...WIDGET_CONFIG_CACHE_KEY.queryStrings] },
    },
    enableAcceptEncodingBrotli: true,
    enableAcceptEncodingGzip: true,
  },
});
