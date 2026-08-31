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
  'packages/core',
  'packages/db',
  'packages/security',
  'packages/testing',
  'apps/api',
  'apps/worker',
];

/** Browser-side code: needs a DOM to render into. */
const DOM_PROJECTS = ['apps/dashboard', 'apps/widget'];

const project = (root: string, environment: 'node' | 'jsdom') => ({
  test: {
    name: root.split('/')[1],
    root,
    environment,
    include: ['test/**/*.test.ts'],
  },
});

export default defineConfig({
  test: {
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
      include: ['{apps,packages}/*/src/**/*.ts'],
      exclude: ['**/*.d.ts'],
      // Files with zero tests must still count against the bars, or coverage
      // rises by deleting test files.
      all: true,
    },
  },
});
