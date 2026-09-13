import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * What the dashboard's first load downloads (P1-18).
 *
 * **A static import of the spreadsheet reader would pass every other test.**
 * The import screen would work, the page would load, and first load would carry
 * a parser most sellers never use. So this reads the built output: the chunks
 * `index.html` loads up front must not contain the reader.
 *
 * It needs `apps/dashboard/dist`, which every test script builds first; the CI
 * test job builds before it runs. A missing build fails here by name rather
 * than passing on nothing.
 */

const DIST = join(import.meta.dirname, '..', 'dist');
const READER = join(
  import.meta.dirname,
  '..',
  'node_modules',
  'read-excel-file',
  'modules',
  'xlsx',
);

/** A path every workbook read opens, so it is in the reader's code whatever minifies it. */
const SIGNATURE = 'xl/workbook.xml';

describe('the dashboard bundle', () => {
  it('knows what the reader looks like, so the check below can fail', () => {
    const carriers = readdirSync(READER).filter(
      (name) =>
        name.endsWith('.js') && readFileSync(join(READER, name), 'utf8').includes(SIGNATURE),
    );

    expect(carriers.length).toBeGreaterThan(0);
  });

  it('does not load the spreadsheet reader up front', () => {
    const html = join(DIST, 'index.html');
    expect(existsSync(html), 'apps/dashboard/dist is missing: run `pnpm build` first').toBe(true);

    /*
     * The entry script and every chunk it preloads. A static import could land
     * in either: Vite inlines small modules into the entry and splits shared
     * ones into a preloaded vendor chunk.
     */
    const upFront = [
      ...readFileSync(html, 'utf8').matchAll(/(?:src|href)="\/?(assets\/[^"]+\.js)"/g),
    ]
      .map((match) => match[1])
      .filter((path): path is string => path !== undefined);

    expect(upFront.length).toBeGreaterThan(0);

    for (const chunk of upFront) {
      expect(readFileSync(join(DIST, chunk), 'utf8'), chunk).not.toContain(SIGNATURE);
    }
  });
});
