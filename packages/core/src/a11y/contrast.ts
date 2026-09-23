/**
 * Whether a colour a seller picked can be read on (P3-15, §1.7).
 *
 * **A commercial issue before an ethical one.** European accessibility
 * requirements increasingly apply to storefronts, and a widget that fails them
 * becomes the seller's liability rather than ours — which is a conversation no
 * account manager wants to have.
 *
 * **Computed here rather than in either client**, because two of them need it:
 * the widget picks a readable foreground for the tenant's primary colour, and
 * the console warns at configuration time (P4) rather than letting a failing
 * combination ship. One implementation means the warning and the rendering
 * cannot disagree.
 *
 * WCAG 2.1 SC 1.4.3. The maths is the specification's, verbatim.
 */

/** WCAG's threshold for ordinary text. Large text is 3:1, which the widget has none of. */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

/**
 * A colour as three channels, or nothing.
 *
 * `#rgb`, `#rrggbb`, with or without the hash. Anything else is a value a
 * seller typed into a form, and the answer to those is "we cannot tell" rather
 * than a number somebody might act on.
 */
export const channelsOf = (colour: string): readonly [number, number, number] | undefined => {
  const hex = colour.trim().replace(/^#/u, '').toLowerCase();

  if (!/^[0-9a-f]+$/u.test(hex)) return undefined;

  const full =
    hex.length === 3 ? hex.replaceAll(/([0-9a-f])/gu, '$1$1') : hex.length === 6 ? hex : undefined;

  if (full === undefined) return undefined;

  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
};

/** One channel, linearised. The 0.03928 threshold and the 2.4 exponent are WCAG's. */
const linear = (channel: number): number => {
  const value = channel / 255;

  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance, 0 for black and 1 for white. */
export const luminanceOf = (colour: string): number | undefined => {
  const channels = channelsOf(colour);

  if (channels === undefined) return undefined;

  const [red, green, blue] = channels;

  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
};

/**
 * The contrast between two colours, from 1 to 21.
 *
 * `undefined` when either is not a colour we can read — the caller decides what
 * to do about that, and it is never "assume it passes".
 */
export const contrastRatio = (a: string, b: string): number | undefined => {
  const first = luminanceOf(a);
  const second = luminanceOf(b);

  if (first === undefined || second === undefined) return undefined;

  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);

  return (lighter + 0.05) / (darker + 0.05);
};

/**
 * Whether text of one colour is readable on a background of another.
 *
 * **Unreadable input reads as failing.** A seller who typed something that is
 * not a colour has a configuration we cannot vouch for, and "we could not
 * check" must not render as a pass.
 */
export const meetsAA = (foreground: string, background: string, large = false): boolean => {
  const ratio = contrastRatio(foreground, background);

  return ratio !== undefined && ratio >= (large ? AA_LARGE : AA_NORMAL);
};

/** Black and white, as the only two foregrounds the widget will put on a tenant's colour. */
export const BLACK = '#000000';
export const WHITE = '#ffffff';

/**
 * The readable foreground for a background, black or white.
 *
 * **Whichever contrasts more, not whichever looks nicer.** A tenant who picked
 * a pale gold gets black text on it; one who picked a deep bordeaux gets white.
 * Neither is a decision a seller should have to make, and neither is one we
 * should get wrong on their storefront.
 *
 * Falls back to white for a colour we cannot read, which is what the widget's
 * own default (`#7b1e3c`) wants — a value we cannot parse is one the widget
 * will not be applying anyway.
 */
export const readableOn = (background: string): string => {
  const onWhite = contrastRatio(WHITE, background);
  const onBlack = contrastRatio(BLACK, background);

  if (onWhite === undefined || onBlack === undefined) return WHITE;

  return onWhite >= onBlack ? WHITE : BLACK;
};
