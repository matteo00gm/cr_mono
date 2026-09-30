import { createRequire } from 'node:module';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { describeThreat, REPO } from './manifest.js';

/**
 * T7 — XSS the seller's storefront through the widget (§3.0, P4-17).
 *
 * The widget renders into a shadow root with text nodes only, and the lint rule
 * that bans `innerHTML` there is part of the evidence — so this file asserts it
 * the way it actually applies: **the configuration ESLint computes for a widget
 * file**, not the text of `eslint.config.js`.
 *
 * That distinction found a real gap while this row was being built. Flat config
 * replaces a rule configured again rather than merging it, and the widget's
 * block re-configured `no-restricted-syntax` over files the raw-fetch ban
 * (P0-63) already covered — so the widget had silently lost that ban. Reading
 * the config text would have shown both rules present; the computed config
 * showed one.
 */
describeThreat('T7');

interface Computed {
  readonly rules?: Record<string, unknown>;
}

interface Linter {
  calculateConfigForFile(path: string): Promise<Computed>;
}

/** ESLint lives at the root; this package does not depend on it, and only reads its config. */
const { ESLint } = createRequire(join(REPO, 'package.json'))('eslint') as {
  ESLint: new (options: { cwd: string }) => Linter;
};

const selectorsFor = async (file: string): Promise<string[]> => {
  const computed = await new ESLint({ cwd: REPO }).calculateConfigForFile(join(REPO, file));
  const rule = computed.rules?.['no-restricted-syntax'];

  return Array.isArray(rule)
    ? rule.slice(1).map((entry) => (entry as { selector: string }).selector)
    : [];
};

describe('the widget’s lint rules, as ESLint computes them for a widget file', () => {
  it('ban innerHTML and dangerouslySetInnerHTML', async () => {
    const selectors = await selectorsFor('apps/widget/src/panel.ts');

    expect(selectors).toContain("MemberExpression[property.name='innerHTML']");
    expect(selectors).toContain("JSXAttribute[name.name='dangerouslySetInnerHTML']");
  }, 60_000);

  it('keep the raw-fetch ban beside them (P0-63)', async () => {
    const selectors = await selectorsFor('apps/widget/src/panel.ts');

    expect(selectors.filter((selector) => selector.includes("callee.name='fetch'"))).toHaveLength(
      2,
    );
  }, 60_000);
});
