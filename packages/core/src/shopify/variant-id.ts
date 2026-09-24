/**
 * The Shopify variant id, in whichever shape a seller pasted (P3-11, §1.6).
 *
 * **Normalised on the way in, not at the cart.** Sellers paste whatever their
 * source gives them: a bare numeric id from a CSV export, or a GraphQL global
 * id from the admin API or a newer export. `/cart/add.js` accepts only the
 * numeric form — so a stored GID produces a product that looks correctly
 * configured in the console and silently fails at the moment a visitor clicks
 * *Aggiungi al carrello*. That is the worst possible place to discover it, and
 * the cheapest place to prevent it is the two writes: the P1-01 form and the
 * P1-24 upsert.
 *
 * **Not `sku`, and not a product handle.** Both look like plausible
 * identifiers to somebody filling in a spreadsheet, and neither works. The
 * refusal names both accepted formats, because "invalid" tells a seller
 * nothing they can act on.
 */

/** What Shopify's admin API and newer exports emit. */
const GID = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/u;

/** What `/cart/add.js` accepts, and what a CSV export usually contains. */
const NUMERIC = /^\d+$/u;

/**
 * The message a seller reads when the value is neither.
 *
 * Italian, like the rest of the console, and it names both shapes rather than
 * saying "non valido" — a seller who pasted a SKU has to be told what to paste
 * instead.
 */
export const VARIANT_ID_EXPECTED =
  'ID variante non valido. Usa il numero (per esempio 45123456789) ' +
  'oppure il formato gid://shopify/ProductVariant/45123456789.';

export type VariantId =
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string };

/**
 * Reads a variant id, accepting either shape.
 *
 * **An empty value is not an error.** Most catalogues are not on Shopify and
 * the column is optional; a seller who left it blank gets a card with "Vedi
 * prodotto" rather than a validation failure on every row of their import.
 */
export const readVariantId = (value: string | null | undefined): VariantId | undefined => {
  const trimmed = (value ?? '').trim();

  if (trimmed === '') return undefined;

  if (NUMERIC.test(trimmed)) return { ok: true, id: trimmed };

  const gid = GID.exec(trimmed);

  if (gid?.[1] !== undefined) return { ok: true, id: gid[1] };

  return { ok: false, message: VARIANT_ID_EXPECTED };
};
