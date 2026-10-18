import { defineConfig } from 'vitest/config';

/**
 * The retrieval headroom check (P7-05): real Postgres, thirty wineries, and
 * minutes of seeding.
 *
 * Its own configuration because it belongs in neither suite. Not the unit
 * suite, which needs no Docker; not the integration suite, which runs on every
 * pull request — sixty thousand vectors would add minutes to each one, and a
 * latency figure from a shared runner is noise anyway. It runs on demand,
 * `pnpm test:headroom`, when the corpus or the retrieval statement changes
 * shape, and its figures go in the plan.
 */
export default defineConfig({
  test: {
    name: 'headroom',
    environment: 'node',
    env: { LOG_LEVEL: 'silent' },
    include: ['packages/db/test/**/*.headroom.test.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 180_000,
  },
});
