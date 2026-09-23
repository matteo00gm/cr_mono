import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The coverage gate, made to refuse (P0-07).
 *
 * `check-coverage.mjs` takes a summary path "so the failure modes can be tested
 * against a fixture", and nothing did — every refusal it makes had only ever
 * been seen to pass. That is the repository's first verification rule broken
 * by the gate that enforces the others: its vacuous-pass check exists because
 * the Windows path bug once reported all-green while measuring zero, and until
 * now nothing would notice that check being deleted.
 *
 * Run as CI runs it, as a child process, because what a gate means is its exit
 * status. The fixtures are built from the packages actually on disk, so a
 * package added tomorrow is in them without anybody editing this file.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-coverage.mjs');
const METRICS = ['lines', 'statements', 'functions', 'branches'];

const scratch = mkdtempSync(join(tmpdir(), 'check-coverage-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Every workspace package, discovered the way the script discovers them. */
const packages = () =>
  ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(ROOT, group), { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && existsSync(join(ROOT, group, entry.name, 'package.json')),
      )
      .map((entry) => `${group}/${entry.name}`),
  );

const counts = (covered, total) => ({ total, covered, skipped: 0, pct: (covered / total) * 100 });

const full = () => Object.fromEntries(METRICS.map((metric) => [metric, counts(10, 10)]));

/**
 * A summary in which every package has one file at 100%, keyed the way v8
 * writes it — absolute, native separators — with `overrides` replacing a
 * package's entry and `null` removing it.
 */
const summary = (overrides = {}) => {
  const entries = packages()
    .map((pkg) => [pkg, pkg in overrides ? overrides[pkg] : full()])
    .filter(([, entry]) => entry !== null)
    .map(([pkg, entry]) => [join(ROOT, pkg, 'src', 'index.ts'), entry]);

  return { total: full(), ...Object.fromEntries(entries) };
};

let written = 0;

const gate = (contents) => {
  const path = join(scratch, `summary-${String((written += 1))}.json`);
  if (contents !== undefined) writeFileSync(path, JSON.stringify(contents));

  return spawnSync(process.execPath, [SCRIPT, path], { cwd: ROOT, encoding: 'utf8' });
};

describe('check-coverage.mjs', () => {
  it('passes when every package meets its bar', () => {
    const result = gate(summary());

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('All gates pass.');
  });

  it('fails a package below its bar, and names the package and the metric', () => {
    const result = gate(summary({ 'packages/core': { ...full(), lines: counts(50, 100) } }));

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/packages\/core\s+lines\s+50\.00%\s+90%.*FAIL/);
    expect(result.stderr).toContain('below threshold');
  });

  it('holds packages/security to exactly 100%, with no rounding in its favour', () => {
    const result = gate(
      summary({ 'packages/security': { ...full(), branches: counts(9_999, 10_000) } }),
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/packages\/security\s+branches\s+99\.99%\s+100%.*FAIL/);
  });

  it('refuses the vacuous pass, where no path in the summary belongs to a package', () => {
    /*
     * The Windows bug's shape: a summary was found and every key missed every
     * package, so each bar compared against nothing and trivially succeeded.
     */
    const result = gate({ total: full(), [join(scratch, 'elsewhere', 'src', 'index.ts')]: full() });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('vacuous pass');
  });

  it('refuses a summary that has no files for one package, and names it', () => {
    const result = gate(summary({ 'packages/db': null }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/db');
  });

  it('still refuses a *non*-exempt package with no files, which is the whole guard', () => {
    /*
     * The guard exists to catch a path-normalisation bug that would make every
     * bar compare against zero. Exempt packages were taken out of it when
     * `apps/e2e` arrived — Playwright runs that one, so it can never appear in
     * a Vitest summary — and this is the assertion that taking them out did not
     * take the guard with them.
     */
    const result = gate(summary({ 'apps/api': null }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/api');
  });

  it('passes an exempt package that has no files at all', () => {
    // `apps/e2e` is never in a Vitest summary and must not fail the gate for it.
    const result = gate(summary({ 'apps/e2e': null }));

    expect(result.status).toBe(0);
  });

  it('refuses to run with no summary at all', () => {
    const result = gate(undefined);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no coverage summary');
  });
});
