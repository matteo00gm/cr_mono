import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The bundle budget, made to refuse (P3-02).
 *
 * **A budget that has only ever been seen to pass is not a budget.** §1.1's
 * 5 KB is a promise to the seller, and the way that promise breaks is a
 * convenient import landing in the loader — so what has to be demonstrated is
 * the *refusal*, against a file deliberately over the line.
 *
 * Run as CI runs it, as a child process, because what a gate means is its exit
 * status. The script takes a directory "so the failure modes can be tested
 * against a fixture", and this is what makes that true.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-bundle-size.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'bundle-size-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let made = 0;

/** A real newline, kept out of the literals below so nothing has to escape one. */
const NEWLINE = String.fromCharCode(10);

/**
 * A directory holding a `loader.js` of roughly the gzipped size asked for.
 *
 * Random bytes, because they do not compress: a file of repeated characters
 * gzips to almost nothing, and a fixture built that way could not be made to
 * exceed any budget worth setting.
 */
const bundleOf = (gzippedBytes, loaderPrefix = '') => {
  const dir = join(scratch, `case-${String((made += 1))}`);

  mkdirSync(dir, { recursive: true });

  let body = Buffer.alloc(0);

  while (gzipSync(body, { level: 9 }).length < gzippedBytes) {
    body = Buffer.concat([
      body,
      Buffer.from(Array.from({ length: 512 }, () => Math.random() * 256)),
    ]);
  }

  writeFileSync(join(dir, 'loader.js'), Buffer.concat([Buffer.from(loaderPrefix), body]));
  /* Every budgeted bundle must exist, or the gate fails for that reason instead. */
  writeFileSync(join(dir, 'widget.js'), 'export const mountPanel = () => {};');

  return dir;
};

const check = (dir) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

describe('a bundle inside its budget', () => {
  it('passes, and says what it measured', () => {
    const result = check(bundleOf(1024));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('loader.js');
    expect(result.stdout).toContain('pass');
  });
});

describe('the widget bundle', () => {
  it('is budgeted too, and its ceiling is the larger one', () => {
    /*
     * Twelve times the loader's, and the ratio is the argument for the split:
     * this is paid once by the visitors who open the widget, and the loader is
     * paid by everybody else.
     */
    const dir = join(scratch, 'widget-over');

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'loader.js'), 'const a=1;');

    let body = Buffer.alloc(0);

    while (gzipSync(body, { level: 9 }).length < 61 * 1024) {
      body = Buffer.concat([
        body,
        Buffer.from(Array.from({ length: 4096 }, () => Math.random() * 256)),
      ]);
    }

    writeFileSync(join(dir, 'widget.js'), body);

    const result = check(dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('widget.js');
    expect(result.stderr).toContain('60 KB budget');
  });
});

describe('a bundle over its budget', () => {
  it('fails, which is the whole point of the gate', () => {
    // The shape of the real regression: a convenient import lands in the
    // loader, and every visitor to every storefront pays for it.
    const result = check(bundleOf(6 * 1024));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL');
  });

  it('says how far over, and why the budget exists', () => {
    const result = check(bundleOf(6 * 1024));

    expect(result.stderr).toMatch(/over its 5 KB budget/);
    expect(result.stderr).toContain('every page of a storefront');
  });
});

describe('a budgeted bundle that was not built', () => {
  it('fails rather than passing over an empty directory', () => {
    /*
     * The vacuous pass: an entry renamed takes its budget with it, and a gate
     * that iterates the build rather than the budgets reports success having
     * measured nothing.
     */
    const empty = join(scratch, 'empty');

    mkdirSync(empty, { recursive: true });

    const result = check(empty);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('A budget nobody measures is not a budget');
  });
});

describe('no build at all', () => {
  it('says to run the build rather than passing', () => {
    const result = check(join(scratch, 'does-not-exist'));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('build:bundle');
  });
});

describe('the two entries collapsing into one', () => {
  it('fails on a loader with a static import, though both budgets pass', () => {
    /*
     * **The regression the budgets cannot see, and the reason this check is
     * not a size threshold.** A refactor that turns the dynamic import into a
     * static one makes Rollup emit a shared chunk, which the loader then
     * imports at the top: the loader is still small, the widget entry is still
     * small, and the shared chunk carrying the widget is charged to neither —
     * while every visitor downloads it before the page is interactive.
     *
     * The first version of this check looked for marker strings inside
     * `loader.js` and passed, because the code had moved to a third file.
     */
    const result = check(bundleOf(1024, 'import{a}from"./panel.js";' + NEWLINE));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('static import');
  });

  it('allows the dynamic import that is the whole design', () => {
    const result = check(bundleOf(1024, 'const m=()=>import("./widget.js");' + NEWLINE));

    expect(result.status).toBe(0);
  });

  it('is not tripped by import.meta', () => {
    expect(check(bundleOf(1024, 'const u=import.meta.url;' + NEWLINE)).status).toBe(0);
  });
});

describe('what it measures', () => {
  it('measures gzipped bytes, not raw', () => {
    /*
     * **The one that would pass for months.** Minified JavaScript compresses
     * to roughly a third, so a raw budget of 5 KB is a gzipped budget of about
     * fifteen — and every byte on this path crosses the network gzipped.
     */
    const raw = 6 * 1024;
    const dir = join(scratch, 'compressible');

    mkdirSync(dir, { recursive: true });
    // Repeated bytes: far over the budget raw, far under it gzipped.
    writeFileSync(join(dir, 'loader.js'), 'x'.repeat(raw * 4));
    writeFileSync(join(dir, 'widget.js'), 'export const mountPanel = () => {};');

    expect(check(dir).status).toBe(0);
  });
});
