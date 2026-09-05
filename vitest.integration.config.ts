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
    /*
     * Same reason as the unit config: the API logs a line per request and one
     * per handled error, and the auth suites deliberately produce hundreds of
     * refusals — enough to bury the actual failure in the report.
     *
     * Only the process logger is silenced. Suites that assert on log *output*
     * build their own logger from the exported `loggerOptions` with an explicit
     * level, which is why those options are exported separately.
     */
    env: { LOG_LEVEL: 'silent' },
    /*
     * Rooted at the workspace rather than at packages/db, since P0-44 puts the
     * harness — and its smoke test — in packages/testing.
     *
     * `apps/*` was added deliberately in P0-45, which is the widening the
     * original note asked for rather than a glob nobody revisited. The reason
     * is specific: Better Auth's wiring cannot be verified against a fake. A
     * stub `getSession` proves the guard is mounted in the right place and
     * nothing about whether the library can actually reach the `auth_*` tables
     * — and the first draft of this task shipped a `basePath` that would have
     * 404'd every auth endpoint in production while the unit suite stayed
     * green. Anything under apps/ that needs a container belongs here.
     */
    include: ['{apps,packages}/*/test/**/*.integration.test.ts'],
    // Container start dominates; the assertions themselves are milliseconds.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
