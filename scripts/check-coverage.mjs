#!/usr/bin/env node
/**
 * Enforces the §6.2 per-package coverage bars against the single root
 * `coverage/coverage-summary.json` that `pnpm test:coverage` writes.
 *
 * Why a script instead of Vitest's own `coverage.thresholds`: with
 * `test.projects`, Vitest applies coverage once at the root of the run rather
 * than per project, so there is nowhere in Vitest config to express a
 * *different* bar per package.
 *
 * Usage: node scripts/check-coverage.mjs [path/to/coverage-summary.json]
 * The optional argument exists so the failure modes can be tested against a
 * fixture without disturbing real coverage output.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { die as reportDie, table } from './lib/report.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const METRICS = ['lines', 'statements', 'functions', 'branches'];

/**
 * §6.2, plus three bars that section left unstated (marked below).
 *
 * A package on disk with no entry here is a hard failure, not a silent pass —
 * the same rule §6.3 applies to an endpoint missing a capability entry. That
 * is the only thing stopping a new package from arriving with no bar at all.
 */
const THRESHOLDS = {
  'packages/security': { lines: 100, statements: 100, functions: 100, branches: 100 },
  'packages/core': { lines: 90, branches: 90 },
  'packages/db': { lines: 90, branches: 90 },
  'apps/api': { lines: 85, branches: 85 },
  'apps/widget': { lines: 85, branches: 85 },

  // Not specified in §6.2 — chosen here, and open to revision.
  'apps/worker': { lines: 85, branches: 85 },
  'apps/dashboard': { lines: 80, branches: 80 },
  'packages/testing': {
    exempt:
      'Test helpers run inside the suites that consume them, where v8 attributes ' +
      'the coverage to the consuming project. A bar here would measure nothing.',
  },
};

const die = (msg) => reportDie('coverage gate failed: ' + msg);

/** Workspace packages actually present on disk. */
const discover = () =>
  ['apps', 'packages'].flatMap((group) => {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'package.json')))
      .map((e) => group + '/' + e.name);
  });

/**
 * Summary keys are absolute *native* paths — on Windows, with backslashes.
 * Grouping on them directly matches nothing, every package aggregates as
 * empty, and the gate reports all-green while measuring zero.
 */
const PKG_PATH = new RegExp('^(apps|packages)/([^/]+)/');

const toPackage = (key) => {
  // `relative` understands the native separator on both platforms; `sep`
  // then normalises the result so the pattern below always sees forward
  // slashes. Writing this as a string replacement is how the Windows bug
  // gets reintroduced.
  const rel = relative(ROOT, resolve(key)).split(sep).join('/');
  const m = PKG_PATH.exec(rel);
  return m ? m[1] + '/' + m[2] : null;
};

const pct = (covered, total) => (total === 0 ? 100 : (covered / total) * 100);

// ------------------------------------------------------------------ load
const summaryPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(ROOT, 'coverage', 'coverage-summary.json');

if (!existsSync(summaryPath)) {
  die('no coverage summary at ' + summaryPath + ' — run `pnpm test:coverage` first.');
}
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));

// --------------------------------------------------- config versus reality
const onDisk = discover();
const configured = Object.keys(THRESHOLDS);
const noBar = onDisk.filter((p) => !configured.includes(p));
const noPackage = configured.filter((p) => !onDisk.includes(p));

if (noBar.length) {
  die(
    'these packages exist but have no coverage bar in scripts/check-coverage.mjs:\n    ' +
      noBar.join('\n    ') +
      '\n\n  Add one. A package without a bar is an untested package nobody notices.',
  );
}
if (noPackage.length) {
  die('these coverage bars name packages that do not exist:\n    ' + noPackage.join('\n    '));
}

// --------------------------------------------------------------- aggregate
const acc = new Map(
  onDisk.map((p) => [
    p,
    { files: 0, ...Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }])) },
  ]),
);

let unattributed = 0;
for (const [key, entry] of Object.entries(summary)) {
  if (key === 'total') continue;
  const pkg = toPackage(key);
  if (!pkg || !acc.has(pkg)) {
    unattributed++;
    continue;
  }
  const a = acc.get(pkg);
  a.files++;
  for (const m of METRICS) {
    if (!entry[m]) continue;
    a[m].covered += entry[m].covered;
    a[m].total += entry[m].total;
  }
}

// The vacuous pass this script exists to prevent.
const empty = onDisk.filter((p) => acc.get(p).files === 0);
if (empty.length) {
  die(
    'the summary contains no files for:\n    ' +
      empty.join('\n    ') +
      '\n\n  This is the vacuous pass: a summary was found but its paths matched no\n' +
      '  package, so every bar would compare against zero and trivially succeed.\n' +
      '  Check path normalisation here and `coverage.include` in vitest.config.ts.',
  );
}

// ---------------------------------------------------------------- evaluate
const rows = [];
let failed = 0;

for (const pkg of onDisk) {
  const bar = THRESHOLDS[pkg];
  const a = acc.get(pkg);

  if (bar.exempt) {
    rows.push([pkg, '(exempt)', '-', '-', '-', String(a.files), 'skip']);
    continue;
  }

  for (const [metric, required] of Object.entries(bar)) {
    const { covered, total } = a[metric];
    const actual = pct(covered, total);
    const ok = actual + 1e-9 >= required;
    if (!ok) failed++;
    rows.push([
      pkg,
      metric,
      actual.toFixed(2) + '%',
      required + '%',
      covered + '/' + total,
      String(a.files),
      ok ? 'pass' : 'FAIL',
    ]);
  }
}

console.log('\n  Coverage gates (§6.2)\n');
console.log(table(['Package', 'Metric', 'Actual', 'Required', 'Covered', 'Files', ''], rows));
if (unattributed) {
  console.log('\n  note: ' + unattributed + ' file(s) in the summary matched no package.');
}

if (failed) {
  console.error('\n  ' + failed + ' gate(s) below threshold. See the FAIL rows above.\n');
  process.exit(1);
}
console.log('\n  All gates pass.\n');
