import { defineConfig } from 'vitest/config';

/**
 * The security package's own suite, for Stryker to drive (P4-16).
 *
 * The root config runs every package as one multi-project run; Stryker needs a
 * config that runs this package alone, from this package's directory, so each
 * mutant costs this suite and nothing else. Same include and exclude as the
 * root's project for it — a narrower set here would report mutants as
 * surviving that the real suite kills.
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.integration.test.ts'],
    env: { LOG_LEVEL: 'silent' },
  },
});
