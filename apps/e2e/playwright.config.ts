import process from 'node:process';

import { defineConfig, devices } from '@playwright/test';

/*
 * **Set here, before anything imports the API.** Half this suite refuses
 * requests on purpose, each one logging a warning with a full stack, and a
 * dozen of those bury the line that says which assertion failed. The logger
 * reads its level once at import, so setting it inside a fixture is too late.
 *
 * It silences the process logger only — nothing in this suite asserts on log
 * output, and the `security_events` rows it *does* assert on are database rows.
 */
process.env['LOG_LEVEL'] ??= 'silent';

/**
 * The browser suite (P3-18, §6.3).
 *
 * **Local only, and deliberately not in `pnpm test`.** It needs Docker for
 * Postgres and a downloaded browser, which is a different set of prerequisites
 * from the unit suites — a developer running `pnpm test` on a laptop with
 * neither should get a green run, not a mysterious container error. `pnpm e2e`
 * is the entry point, and CI gets its own job rather than being folded into the
 * one that has to stay fast.
 *
 * **One worker, no retries.** Every test shares one database, one API and two
 * ports; parallel workers would race over the seeded domain that one test
 * deliberately un-verifies. Retries would hide a flake, and a flake in the suite
 * that proves the browser enforces CORS is a thing to investigate rather than
 * paper over.
 */
export default defineConfig({
  testDir: './test',
  testMatch: /.*\.spec\.ts/u,

  /* Serial: the state is shared and one test mutates it on purpose. */
  workers: 1,
  fullyParallel: false,
  retries: 0,

  /* A container start plus a migration is slow once and fast afterwards. */
  timeout: 30_000,
  globalTimeout: 10 * 60_000,

  expect: { timeout: 10_000 },

  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['github']],

  use: {
    /* Chromium only. The thing under test is the CORS algorithm, which is a
     * specification rather than a vendor behaviour; P3-18's screenshots are
     * where a second engine would earn its runtime. */
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium' }],
});
