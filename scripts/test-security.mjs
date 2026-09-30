#!/usr/bin/env node
/**
 * `pnpm test:security` — the T1–T10 matrix, run (P4-17).
 *
 * Runs exactly the files `packages/security/test/threats/threats.json` names as
 * evidence, plus the threat suites themselves: the unit files through the unit
 * config, the Postgres ones through the integration config (Docker required).
 * The browser evidence (T1's cross-origin spec) is listed and not run here — it
 * needs the widget bundle and a Playwright browser, and CI's cross-origin job
 * runs it on every pull request.
 *
 * Usage:
 *   node scripts/test-security.mjs          # unit and integration
 *   node scripts/test-security.mjs --unit   # unit only, no Docker
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const { threats } = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'security', 'test', 'threats', 'threats.json'), 'utf8'),
);

const byRunner = (runner) => [
  ...new Set(
    threats.flatMap((threat) =>
      threat.evidence.filter((item) => item.runner === runner).map((item) => item.path),
    ),
  ),
];

const unit = ['packages/security/test/threats', ...byRunner('unit')];
const integration = byRunner('integration');
const e2e = byRunner('e2e');

const run = (label, files, config = []) => {
  console.log(`\n  ${label}: ${String(files.length)} targets\n`);
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...config, ...files], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  return result.status ?? 1;
};

let failed = run('T1–T10, unit', unit) !== 0;

if (!process.argv.includes('--unit')) {
  const status = run('T1–T10, integration', integration, [
    '--config',
    'vitest.integration.config.ts',
  ]);

  failed = status !== 0 || failed;
}

console.log(`\n  Browser evidence, run by CI's cross-origin job: ${e2e.join(', ')}\n`);

process.exit(failed ? 1 : 0);
