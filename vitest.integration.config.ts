import { defineConfig } from 'vitest/config';

/**
 * Integration suite: real Postgres via Testcontainers.
 *
 * Separate from `vitest.config.ts` so `pnpm test` stays fast and needs no
 * Docker. §6.4 runs both in CI, in that order — a unit suite you hesitate to
 * run is a unit suite that stops being run.
 */
export default defineConfig({
  test: {
    name: 'integration',
    environment: 'node',
    // Rooted at the workspace rather than at packages/db, since P0-44 puts the
    // harness — and its smoke test — in packages/testing. Scoped to packages/*
    // so an integration suite added under apps/ has to widen this deliberately
    // rather than being picked up by a glob nobody revisited.
    include: ['packages/*/test/**/*.integration.test.ts'],
    // Container start dominates; the assertions themselves are milliseconds.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
