/**
 * Public surface of `@catalogorosso/testing`.
 *
 * Test-time helpers only. Nothing here may be imported by production code —
 * the dependency rules forbid it, and the factories carry fixture data that
 * would be nonsense in a running system.
 */
export * from './db-harness.js';
export * from './factories.js';
export * from './secrets.js';
export * from './rate-limit-suite.js';

/**
 * Storefronts on origins that are not ours (P3-17).
 *
 * CORS can only be proven from a genuinely different origin, and this is what
 * makes P3-18 possible at all.
 */
export {
  bundleDirectory,
  startHostPages,
  UNVERIFIED_PORT,
  VERIFIED_PORT,
  type CartCall,
  type HostPageOptions,
  type HostPages,
} from './host-pages.js';

/**
 * The API on a port a browser can reach (P3-18).
 *
 * Everything a browser enforces needs a browser to prove, and that needs the
 * real middleware chain answering over HTTP from an origin a page can load.
 */
export {
  API_PORT,
  SEEDED_PRODUCT,
  startE2eApi,
  UNVERIFIED_ORIGIN,
  VERIFIED_ORIGIN,
  WIDGET_KEY,
  type E2eApi,
  type E2eApiOptions,
  type E2eSeed,
} from './e2e-server.js';
