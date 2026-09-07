import { describe, expect, it } from 'vitest';

// @ts-expect-error — a build script, deliberately outside every tsconfig.
import { changelog } from '../../../scripts/changelog.mjs';

/**
 * The changelog generator (P0-61).
 *
 * Tested from fixture subjects rather than from `git log`, so the assertions do
 * not change every time somebody commits — a test whose expected output is
 * whatever the repository currently contains is a test that can only ever pass.
 *
 * It lives in `packages/testing` because that is the package whose job is
 * test-time tooling; the script itself is outside every tsconfig by design, like
 * the other build scripts.
 */

const generate = changelog as (subjects: readonly string[]) => string;

describe('grouping', () => {
  it('groups by task id, which is what says why a change happened', () => {
    const out = generate([
      'P0-45: Better Auth, the one un-scoped path',
      'P0-45: annotate the mock return type',
      'P0-54: the API skeleton',
    ]);

    expect(out).toContain('### P0-45');
    expect(out).toContain('- Better Auth, the one un-scoped path');
    expect(out).toContain('- annotate the mock return type');
    expect(out).toContain('### P0-54');
  });

  it('puts task ids before areas, and orders each', () => {
    /*
     * A reader scanning a release wants the backlog rows. CI and dependency
     * noise belongs after them rather than interleaved by whatever order git
     * happened to return.
     */
    const out = generate([
      'Deps: update dependency vitest',
      'P0-54: the API skeleton',
      'CI: run the integration suite',
      'P0-17a: CloudFront behaviours',
    ]);

    const order = ['### P0-17a', '### P0-54', '### CI', '### Deps'].map((h) => out.indexOf(h));

    expect(order.every((i) => i !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('what it ignores', () => {
  it('drops merge commits and anything without a recognised subject', () => {
    // Merge commits carry no information a reader of a changelog wants, and a
    // subject that does not match the convention cannot be attributed.
    const out = generate([
      'Merge pull request #66 from matteo00gm/gitleaks-resend-rule',
      'fixed some stuff',
      'P0-54: the API skeleton',
    ]);

    expect(out).not.toContain('Merge pull request');
    expect(out).not.toContain('fixed some stuff');
    expect(out).toContain('### P0-54');
  });

  it('returns an empty string when nothing qualifies', () => {
    // The caller decides what to print for "nothing to report"; returning a
    // sentence here would end up in a file that claims a release happened.
    expect(generate(['Merge pull request #1 from x/y', 'wip'])).toBe('');
  });
});
