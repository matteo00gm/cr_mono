import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The subpaths a browser bundle may import (P1-13, P1-11).
 *
 * `.dependency-cruiser.mjs` stops the dashboard and the widget importing the
 * `core` barrel, which drags `drizzle-orm` and an auth server into a page. It
 * does not — and as written cannot — stop a *subpath* from doing the same thing
 * one import later. So the promise each subpath makes is checked here instead:
 * its file imports nothing at all.
 *
 * Every export other than `.` is covered, so a new subpath is held to the rule
 * the moment it is declared rather than when somebody remembers to add it.
 */

const ROOT = join(import.meta.dirname, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, { default: string }>;
};

const subpaths = Object.entries(pkg.exports).filter(([subpath]) => subpath !== '.');

describe('browser-safe subpaths', () => {
  it('exist, so the check below is not vacuous', () => {
    expect(subpaths.map(([subpath]) => subpath)).toEqual(
      expect.arrayContaining(['./completeness', './inline-edit']),
    );
  });

  it.each(subpaths)('%s imports nothing', (_subpath, target) => {
    const source = join(ROOT, target.default.replace('./dist/', 'src/').replace(/\.js$/, '.ts'));
    const code = readFileSync(source, 'utf8');

    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/^\s*export\s[^;]*\sfrom\s/m);
    expect(code).not.toMatch(/\bimport\(|\brequire\(/);
  });
});
