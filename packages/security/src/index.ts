/**
 * Public surface of `@catalogorosso/security`.
 *
 * Security primitives with no AWS in them, so their tests stay plain unit
 * tests with no mocked cloud — the P0-09 boundary rule, and the reason this
 * package exists separately from `core`.
 *
 * **`guardedFetch` is deliberately not here**, on the `./net` subpath instead:
 * it imports `node:https` and `node:dns`, and this barrel is bundled into the
 * dashboard, where a browser build that resolves `node:dns` fails (P4-03a).
 */
export * from './capabilities.js';
export * from './origin/normalize.js';
export * from './redact.js';
export * from './redact-pii.js';
export * from './rate-limit/index.js';
