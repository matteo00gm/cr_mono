/**
 * What is safe to show a shopper (P3-08, §1.5, §3.7).
 *
 * **Pure functions, so the XSS suite can hit them directly** as well as through
 * a rendering. The rendering is where escaping happens — Preact escapes a text
 * node and the P0-04 lint rule keeps anybody from reaching past it — and this
 * is about the things escaping does not fix: a `javascript:` URL, a reason a
 * hundred kilobytes long, a right-to-left override that rewrites the line
 * around it.
 *
 * **The dangerous inputs are not all from the model.** `reason` is, and the
 * rest of the card is tenant-authored, arriving through a spreadsheet import
 * that anybody in a winery can edit. Neither is trusted here.
 */

/** Long enough for the one line §1.5 describes, short enough that no card is a wall. */
export const MAX_REASON = 240;

/**
 * Characters that are not text, whatever a font does with them.
 *
 * C0 and C1 controls, and the bidirectional marks and overrides. The overrides
 * matter on their own: `U+202E` reverses everything after it, so a product name
 * can be made to read as a different one on screen while being something else
 * in the DOM — the trick behind filename spoofing, and it works just as well in
 * a card. Escaping does nothing about it at all.
 *
 * **Built from a string rather than written as a regex literal**, because the
 * literal form puts raw control characters in this file the moment a formatter
 * or an editor normalises the escapes — which has happened here, and which is
 * also what `no-control-regex` is warning about when it fires on the literal.
 */
const NOT_TEXT = new RegExp(
  // eslint-disable-next-line no-control-regex -- stripping control characters is the job
  '[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]',
  'gu',
);

/**
 * A single line of plain text, capped.
 *
 * **Not escaping** — the renderer does that. Stripping, collapsing and capping,
 * which escaping does not do: an escaped hundred-kilobyte reason is still a
 * hundred kilobytes of card.
 */
export const asLine = (value: string, max = MAX_REASON): string => {
  const stripped = value.replaceAll(NOT_TEXT, '').replaceAll(/\s+/gu, ' ').trim();

  return stripped.length <= max ? stripped : `${stripped.slice(0, max - 1).trimEnd()}…`;
};

/**
 * A URL a browser may follow, or nothing.
 *
 * **An allowlist of two schemes, not a search for `javascript:`.** A blocklist
 * loses to `jAvAsCrIpT:`, to a leading tab that a browser strips before
 * parsing, and to `data:text/html`. Handing the string to the URL parser and
 * asking what scheme it *actually* is has none of those holes.
 *
 * Relative URLs resolve against the shop's own page, which is where a product
 * link belongs, so the base is the host page rather than the API.
 */
export const asHttpUrl = (value: string | null, base?: string): string | undefined => {
  if (value === null || value === '') return undefined;

  try {
    const url = new URL(value, base ?? globalThis.location.href);

    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    /* Not a URL at all. A seller's spreadsheet contains stranger things. */
    return undefined;
  }
};

/**
 * Money, in the currency the winery sells in.
 *
 * **Wrapped, because `currency` comes from a spreadsheet.** `Intl` throws on
 * anything that is not a well-formed currency code, and a seller who typed
 * `EURO` into a column would otherwise take the whole card down — every card,
 * on every answer, on their own storefront.
 */
export const asPrice = (cents: number, currency: string, locale: string): string => {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${asLine(currency, 8)}`;
  }
};
