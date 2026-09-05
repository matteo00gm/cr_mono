/**
 * Public surface of `@catalogorosso/security`.
 *
 * Security primitives with no HTTP and no AWS in them, so their tests stay
 * plain unit tests with no mocked cloud — the P0-09 boundary rule, and the
 * reason this package exists separately from `core`.
 */
export * from './redact.js';
