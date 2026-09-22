#!/usr/bin/env node
/**
 * Enforces the §1.1 bundle budgets against a real build (P3-02, P3-05).
 *
 * **Gzipped, never raw.** Every byte on this path crosses a network gzipped,
 * so a raw budget measures something no visitor experiences — and the two
 * diverge in the direction that matters: minified JavaScript compresses well,
 * so a raw budget passes long after a gzipped one would have failed.
 *
 * **A script rather than `size-limit`.** The budget is four numbers and a
 * comparison; a dependency to hold them would be a dependency to keep current,
 * and this repository already keeps its checks as scripts with their own tests.
 *
 * Usage: node scripts/check-bundle-size.mjs [path/to/bundle/dir]
 * The optional argument exists so the failure modes can be tested against a
 * fixture without running a build.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { die as reportDie, table } from './lib/report.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * §1.1's promise to the seller, in bytes gzipped.
 *
 * **The loader is the one that is a product constraint rather than a
 * preference.** It runs on every page of a storefront whether or not anybody
 * opens the widget, so its size is paid by every visitor to every shop — which
 * is why it is an order of magnitude below the widget's own.
 */
const BUDGETS = {
  'loader.js': { limit: 5 * 1024, why: '§1.1: runs on every page of a storefront' },
  /*
   * Twelve times the loader's, and that ratio is the argument for the split:
   * this is paid once by the visitors who open the widget, and the loader is
   * paid by everybody else.
   */
  'widget.js': { limit: 60 * 1024, why: '§1.1: fetched on the first click (P3-05)' },
};

/**
 * A static import in a bundle: `import{x}from"./panel.js"` and friends.
 *
 * `import(` is a *dynamic* import and is the whole design (P3-04), so it must
 * not match; `import.meta` must not either. Hence the lookahead.
 */
const STATIC_IMPORT = /(?:^|[;}\s])import\s*(?![(.])/mu;

const gzippedSize = (file) => gzipSync(readFileSync(file), { level: 9 }).length;

const report = (rows) => {
  console.log('');
  console.log(
    table(
      ['bundle', 'gzipped', 'budget', ''],
      rows.map(({ name, size, limit, ok }) => [
        name,
        `${(size / 1024).toFixed(2)} KB`,
        `${(limit / 1024).toFixed(2)} KB`,
        ok ? 'pass' : 'FAIL',
      ]),
    ),
  );
};

const main = () => {
  const dir = resolve(ROOT, process.argv[2] ?? 'apps/widget/dist/bundle');

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    reportDie(
      `No bundle at ${dir}. Run \`pnpm --filter @catalogorosso/widget build:bundle\` first — ` +
        'this check measures a real build, because a budget measured against anything else ' +
        'is a budget nobody is holding.',
    );
  }

  const built = new Set(readdirSync(dir).filter((name) => name.endsWith('.js')));
  const rows = [];

  for (const [name, { limit, why }] of Object.entries(BUDGETS)) {
    /*
     * A budgeted bundle that is not in the build is a failure, not a pass. The
     * alternative is a renamed entry quietly taking its budget with it — a
     * check that measures nothing and reports success.
     */
    if (!built.has(name)) {
      reportDie(
        `${name} is budgeted (${why}) and was not built. A budget nobody measures is not a budget.`,
      );
    }

    const size = gzippedSize(join(dir, name));

    rows.push({ name, size, limit, ok: size <= limit, why });
  }

  report(rows);

  const over = rows.filter((row) => !row.ok);

  if (over.length > 0) {
    reportDie(
      over
        .map(
          ({ name, size, limit, why }) =>
            `${name} is ${((size - limit) / 1024).toFixed(2)} KB over its ${(limit / 1024).toFixed(0)} KB budget (${why}).`,
        )
        .join('\n  '),
    );
  }

  /*
   * **The loader must have no static imports, and this is stronger than any
   * size threshold.** The regression is structural rather than gradual: a
   * refactor that turns the dynamic import into a static one makes Rollup emit
   * a *shared chunk*, which the loader then imports at the top. Both budgets
   * still pass - the loader is measured alone, and the shared chunk is charged
   * to neither - while every visitor to every storefront now downloads the
   * widget before the page has finished loading.
   *
   * That is exactly what happened the first time this check was written to
   * look for marker strings inside `loader.js`: the strings were not there,
   * because the code was in a third file the loader pulled in.
   */
  const loader = readFileSync(join(dir, 'loader.js'), 'utf8');

  if (STATIC_IMPORT.test(loader)) {
    reportDie(
      'loader.js has a static import, so a browser fetches whatever it names before the page ' +
        'is interactive. The two entries have collapsed into a shared chunk, and both budgets ' +
        'still pass because the shared chunk is charged to neither. The widget must be reached ' +
        'only through `import()` (P3-04).',
    );
  }

  console.log('');
  console.log('  Every bundle is inside its budget, and the two entries are still two.');
  console.log('');
};

main();
