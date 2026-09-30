import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The T1–T10 matrix (P4-17, §3.0), read from `threats.json`.
 *
 * **One named file per threat, and each is the index a reviewer opens.** The
 * tests that are a threat's evidence live beside the code they prove — five
 * packages, two runners, three environments — and importing them here would
 * run them twice, outside their own mocks and containers. So a threat's file
 * names its control, lists its evidence, proves every listed file is there and
 * tests something, and says out loud which parts are not built yet.
 * `pnpm test:security` then runs exactly the listed files.
 */

export type Runner = 'unit' | 'integration' | 'e2e';

export interface Evidence {
  readonly path: string;
  readonly runner: Runner;
  readonly covers: string;
}

export interface Gap {
  readonly what: string;
  readonly row: string;
}

export interface Threat {
  readonly id: string;
  readonly slug: string;
  readonly goal: string;
  readonly control: string;
  readonly evidence: readonly Evidence[];
  readonly gaps: readonly Gap[];
}

/** The repository root, which every evidence path is relative to. */
export const REPO = join(import.meta.dirname, '../../../..');

export const THREATS: readonly Threat[] = (
  JSON.parse(readFileSync(join(import.meta.dirname, 'threats.json'), 'utf8')) as {
    threats: Threat[];
  }
).threats;

export const threat = (id: string): Threat => {
  const found = THREATS.find((entry) => entry.id === id);

  if (found === undefined) throw new Error(`${id} is not in threats.json`);

  return found;
};

/** What a file's name says about how it runs, which must agree with the manifest. */
export const runnerOf = (path: string): Runner =>
  path.endsWith('.spec.ts')
    ? 'e2e'
    : path.endsWith('.integration.test.ts')
      ? 'integration'
      : 'unit';

/**
 * The evidence one threat names: every file is there, runs where the manifest
 * says, and holds at least one test. A gap is a `todo`, so it shows in every
 * run's report rather than only in a document.
 */
export const describeThreat = (id: string): void => {
  const entry = threat(id);

  describe(`${entry.id}: ${entry.goal}`, () => {
    it(`names its control: ${entry.control}`, () => {
      expect(entry.control.trim()).not.toBe('');
      /* At least one piece of evidence a CI job runs without a browser. */
      expect(entry.evidence.some((item) => item.runner !== 'e2e')).toBe(true);
    });

    it.each(entry.evidence.map((item) => [item.path, item] as const))(
      'is evidenced by %s',
      (path, item) => {
        const source = readFileSync(join(REPO, path), 'utf8');

        expect(runnerOf(path), path).toBe(item.runner);
        expect(source, `${path} holds no test`).toMatch(/\b(?:it|test)(?:\.each)?\s*[(<]/u);
        expect(item.covers.trim(), path).not.toBe('');
      },
    );

    for (const gap of entry.gaps) it.todo(`${gap.what} — ${gap.row}`);
  });
};
