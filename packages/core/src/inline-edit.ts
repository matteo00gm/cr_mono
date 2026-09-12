/**
 * The fields a seller may edit straight in the catalogue grid (P1-11).
 *
 * **Chosen because they change weekly and, almost always, cost nothing to
 * change.** Opening the full form to move a stock count is friction a seller
 * pays every week; editing a field the model reads in a grid cell would make
 * that same habit a steady stream of embedding calls.
 *
 * The row's premise was that none of these reaches `content_hash`. **That is
 * true of the two stock fields and not quite of price**: P1-33 put a price
 * *band* into the embedding text, so "qualcosa sotto i venti euro" can be
 * answered at all. An edit inside a band costs nothing, which is the ordinary
 * case; one that crosses a band re-embeds, deliberately, because the wine has
 * moved into a different answer. `inline-edit.test.ts` pins both halves.
 *
 * **Widening this list is a design change, not a UI change.** Adding a field
 * the model reads turns a grid cell into a way to spend money on every
 * keystroke the debounce lets through. The test refuses any field it has not
 * been told how to vary, so a new entry cannot land without somebody deciding
 * whether it reaches the embedding.
 *
 * A file that imports nothing, so the dashboard can take it through a subpath
 * without pulling the `core` barrel into a browser (P1-13's rule).
 */
export const INLINE_EDIT_FIELDS = ['priceCents', 'stockStatus', 'stockQty'] as const;

export type InlineEditField = (typeof INLINE_EDIT_FIELDS)[number];
