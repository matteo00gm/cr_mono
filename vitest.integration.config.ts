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

    /**
     * **Four containers at a time, not one per file.**
     *
     * Every file here starts its own Postgres, and the default is to run them
     * all at once. Forty-one containers on a four-vCPU runner is the reason
     * for a cap: each one is a real server with its own shared buffers, and
     * the work is mostly the container starting rather than the assertions
     * running. One worker per vCPU keeps every worker's container the thing it
     * is waiting on.
     *
     * **This cap was originally added on a theory that turned out to be
     * wrong**, and the correction is worth keeping rather than quietly
     * rewriting. It was introduced because
     * `product-embeddings.integration.test.ts` asserted a vector search plans
     * as an HNSW index scan, failed, and passed on a re-run of the identical
     * commit — which reads as contention. It was not. The two plans were
     * within five per cent of each other on cost, so which one won moved with
     * the index's page count over five thousand random vectors. Capping
     * workers made a coin flip land the right way more often, which is the
     * worst kind of fix: it worked, and it worked for a reason that was not
     * true. The assertion was rewritten in #104 to something that cannot flake.
     *
     * So the number stays, on its own merits, and the old reason is gone.
     * Deliberately not 1: a fully serial suite would be minutes slower on every
     * pull request, and a suite people avoid running is the thing this
     * repository has already decided to spend money to prevent (§6.4). At four
     * the whole suite is ~124s on a GitHub runner and ~115s locally.
     */
    maxWorkers: 4,
    minWorkers: 1,
  },
});
