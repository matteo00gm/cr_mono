import { describe, expect, it } from 'vitest';

import {
  AA_LARGE,
  AA_NORMAL,
  channelsOf,
  contrastRatio,
  meetsAA,
  readableOn,
} from '../src/a11y/contrast.js';

/**
 * Whether a colour a seller picked can be read on (P3-15, §1.7).
 *
 * **The anchors are the ones WCAG itself states**: black on white is exactly
 * 21, a colour on itself is exactly 1, and #767676 on white is the canonical
 * boundary case that passes AA by a hair. A reimplementation that drifts fails
 * one of those before it fails anything subtler.
 *
 * The second half is what happens to input a seller typed. A form takes free
 * text, and "we could not check" must never render as a pass — a failing
 * combination that shipped because the checker shrugged is worse than one
 * nobody checked at all.
 */

describe('reading a colour', () => {
  it('reads a six-digit hex', () => {
    expect(channelsOf('#7b1e3c')).toEqual([123, 30, 60]);
  });

  it('reads a three-digit hex, doubling each digit', () => {
    expect(channelsOf('#abc')).toEqual([170, 187, 204]);
  });

  it('does not insist on the hash, which a seller will omit', () => {
    expect(channelsOf('7b1e3c')).toEqual([123, 30, 60]);
  });

  it('is not case-sensitive', () => {
    expect(channelsOf('#7B1E3C')).toEqual(channelsOf('#7b1e3c'));
  });

  it('ignores the whitespace a paste brings with it', () => {
    expect(channelsOf('  #7b1e3c  ')).toEqual([123, 30, 60]);
  });

  it.each(['rebeccapurple', 'rgb(1,2,3)', '#12345', '#1234567', '#gggggg', '', '#'])(
    'refuses %s',
    (value) => {
      expect(channelsOf(value)).toBeUndefined();
    },
  );
});

describe('the ratio', () => {
  it('is 21 for black on white, which is the maximum there is', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('is 1 for a colour on itself', () => {
    expect(contrastRatio('#7b1e3c', '#7b1e3c')).toBeCloseTo(1, 5);
  });

  it('does not care which way round the two are given', () => {
    expect(contrastRatio('#7b1e3c', '#ffffff')).toBe(contrastRatio('#ffffff', '#7b1e3c'));
  });

  it('puts the canonical boundary grey just over the line', () => {
    /* #767676 on white is WCAG's own worked example: 4.54, which passes. */
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });

  it('weights green far above blue, which is the whole point of the formula', () => {
    /*
     * Every grey and every black-on-white case reads the same under equal
     * weights, so only a colour whose channels differ can tell the two apart.
     * Pure green is bright to the eye and pure blue is nearly black.
     */
    expect(contrastRatio('#ffffff', '#00ff00')).toBeCloseTo(1.37, 2);
    expect(contrastRatio('#ffffff', '#0000ff')).toBeCloseTo(8.59, 2);
  });

  it('says nothing about a colour it cannot read', () => {
    expect(contrastRatio('bordeaux', '#ffffff')).toBeUndefined();
    expect(contrastRatio('#ffffff', 'bordeaux')).toBeUndefined();
  });
});

describe('whether it passes AA', () => {
  it('passes the widget own colour with white text', () => {
    // #7b1e3c is the default, and it had better pass its own bar.
    expect(meetsAA('#ffffff', '#7b1e3c')).toBe(true);
  });

  it('fails a pale gold with white text, which is the case that matters', () => {
    /* The seller who picks a light brand colour and would otherwise ship white
     * text nobody can read on it. */
    expect(meetsAA('#ffffff', '#e8c66a')).toBe(false);
  });

  it('holds the thresholds WCAG states', () => {
    expect(AA_NORMAL).toBe(4.5);
    expect(AA_LARGE).toBe(3);
  });

  it('is more forgiving for large text, and only for large text', () => {
    // A ratio between 3 and 4.5: passes large, fails normal.
    expect(meetsAA('#ffffff', '#949494', true)).toBe(true);
    expect(meetsAA('#ffffff', '#949494')).toBe(false);
  });

  it('treats a colour it cannot read as failing', () => {
    /* "We could not check" must never render as a pass. */
    expect(meetsAA('#ffffff', 'bordeaux')).toBe(false);
  });
});

describe('picking a foreground', () => {
  it('puts white on a deep bordeaux', () => {
    expect(readableOn('#7b1e3c')).toBe('#ffffff');
  });

  it('puts black on a pale gold', () => {
    expect(readableOn('#e8c66a')).toBe('#000000');
  });

  it('puts black on white and white on black', () => {
    expect(readableOn('#ffffff')).toBe('#000000');
    expect(readableOn('#000000')).toBe('#ffffff');
  });

  it('always picks the more readable of the two', () => {
    for (const colour of ['#7b1e3c', '#e8c66a', '#808080', '#123456', '#fefefe', '#010101']) {
      const chosen = readableOn(colour);
      const other = chosen === '#ffffff' ? '#000000' : '#ffffff';

      expect(contrastRatio(chosen, colour) ?? 0, colour).toBeGreaterThanOrEqual(
        contrastRatio(other, colour) ?? 0,
      );
    }
  });

  it('falls back to white for a colour it cannot read', () => {
    /* Which is what the widget's own default wants, and a value we cannot parse
     * is one the widget will not be applying anyway. */
    expect(readableOn('bordeaux')).toBe('#ffffff');
  });
});
