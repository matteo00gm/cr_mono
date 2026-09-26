import { config } from 'zod';
import { describe, expect, it } from 'vitest';

import '../src/zod-config.js';

/**
 * zod without its eval probe (P4-12). That the probe is really gone from the
 * page is the browser suite's to prove — it serves the built dashboard under
 * the real CSP and fails on any violation. This pins the setting itself, so a
 * refactor that drops the module fails in milliseconds rather than in a
 * browser.
 */
describe('zod in the dashboard', () => {
  it('never compiles with eval, so a strict CSP has nothing to refuse', () => {
    expect(config().jitless).toBe(true);
  });
});
