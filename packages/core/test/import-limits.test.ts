import { describe, expect, it } from 'vitest';

import {
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
} from '../src/import-limits.js';

/**
 * The import caps both sides read (P1-27).
 *
 * Pinned by value, because the point of sharing them is that changing one is a
 * decision: a test that only compared the dashboard's number with the API's
 * would pass for any number at all.
 */

describe('import limits', () => {
  it('caps an import at ten thousand wines, as §2.2a states', () => {
    expect(MAX_IMPORT_ROWS).toBe(10_000);
  });

  it('caps a file the dashboard reads at 10 MB', () => {
    expect(MAX_IMPORT_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('caps a request at 5 MB, under the 6 MB a Function URL refuses on its own', () => {
    expect(MAX_IMPORT_BODY_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_IMPORT_BODY_BYTES).toBeLessThan(6 * 1024 * 1024);
  });
});
