import { defineConfig } from 'vitest/config';

/**
 * Single Vitest entry point for the whole monorepo: one runner, one coverage
 * report (P0-05). Per-package coverage thresholds are attached in P0-07.
 *
 * Note: the plan called for `defineWorkspace` in a `vitest.workspace.ts`.
 * That API was deprecated in Vitest 3 and removed in Vitest 4 — a
 * `vitest.workspace.ts` file is now a hard error. The equivalent is
 * `test.projects` below.
 *
 * Layout: every package keeps its tests in `test/`, which its `tsconfig.json`
 * includes (so tests are typechecked and type-aware-linted) and its
 * `tsconfig.build.json` does not (so they never reach `dist`).
 */

/** Server-side code: plain Node, no DOM. */
const NODE_PROJECTS = [
  'packages/api-client',
  'packages/core',
  'packages/db',
  'packages/security',
  'packages/testing',
  'apps/api',
  'apps/worker',
  'apps/migrator',
];

/** Browser-side code: needs a DOM to render into. */
const DOM_PROJECTS = ['apps/dashboard', 'apps/widget'];

const project = (root: string, environment: 'node' | 'jsdom') => ({
  test: {
    name: root.split('/')[1],
    root,
    environment,
    /*
     * `.tsx` as well, for the browser-side projects: P0-57's component tests
     * render Preact, and a pattern that matched only `.ts` would silently
     * collect none of them — a suite reported as passing because it was empty.
     */
    include: ['test/**/*.test.{ts,tsx}'],
    // Integration tests need Docker and run from vitest.integration.config.ts.
    exclude: ['test/**/*.integration.test.ts'],
  },
});

export default defineConfig({
  test: {
    env: {
      /*
       * The API logs a line per request and one per handled error, so a full
       * run would bury the report under several hundred JSON lines and make a
       * failure genuinely hard to find.
       *
       * This silences only the process logger. The suites that assert on log
       * *output* build their own logger from the exported `loggerOptions` with
       * an explicit level, so they are unaffected — which is the reason those
       * options are exported separately in the first place.
       */
      LOG_LEVEL: 'silent',
    },
    projects: [
      ...NODE_PROJECTS.map((root) => project(root, 'node')),
      ...DOM_PROJECTS.map((root) => project(root, 'jsdom')),
    ],
    coverage: {
      provider: 'v8',
      // `json-summary` is what the P0-07 gate script reads; lcov feeds the
      // PR annotation; text is for humans running it locally.
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      /*
       * `.tsx` too, since P0-57. Without it the dashboard's components would be
       * outside the report entirely, and its bar would be met by whatever
       * plain-`.ts` modules happened to exist — a gate passing on a package
       * whose actual code it never looked at.
       */
      include: ['{apps,packages}/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        /*
         * Entry points, which do one thing: mount the app into a document.
         * There is no branch to cover and no assertion worth writing — a test
         * would import the module for its side effect and prove that `render`
         * was called, which is the line itself restated.
         *
         * Kept to `main.tsx` by name rather than a pattern, so the exclusion
         * cannot quietly grow to cover a component.
         */
        'apps/*/src/main.tsx',
      ],
      // Files with zero tests must still count against the bars, or coverage
      // rises by deleting test files.
      all: true,
    },
  },
});
