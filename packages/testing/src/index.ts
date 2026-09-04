/**
 * Public surface of `@catalogorosso/testing`.
 *
 * Test-time helpers only. Nothing here may be imported by production code —
 * the dependency rules forbid it, and the factories carry fixture data that
 * would be nonsense in a running system.
 */
export * from './db-harness.js';
export * from './factories.js';
