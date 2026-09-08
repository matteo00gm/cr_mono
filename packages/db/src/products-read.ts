import { and, asc, desc, eq, lt, gt, or, type SQL } from 'drizzle-orm';

import { products } from './schema/products.js';
import type { ProductRow } from './products.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * Catalogue reads (P1-06).
 *
 * Separated from `products.ts` because the write path and the read path have
 * almost nothing in common and both will grow: search (P1-08) and filters
 * (P1-09) compose into the query builder here, and none of them touches the
 * outbox pairing that dominates the write file.
 */

/**
 * Sortable columns, as an allowlist mapping to column objects.
 *
 * **Never a client-supplied name interpolated into SQL**, and the map is what
 * makes that structural rather than a rule: an unknown key has no column to
 * reach, so the failure is a rejected request instead of a string that reached
 * the planner. Small and explicit for the same reason the capability table is —
 * a column becomes sortable when somebody decides it should be.
 *
 * `stockQty` is deliberately absent: it is nullable, and a sort over nulls
 * needs a decision about where they go that no caller has asked for yet.
 */
export const SORTABLE = {
  createdAt: products.createdAt,
  updatedAt: products.updatedAt,
  name: products.name,
  priceCents: products.priceCents,
} as const;

export type SortField = keyof typeof SORTABLE;
export type SortDirection = 'asc' | 'desc';

export const isSortField = (value: string): value is SortField =>
  Object.prototype.hasOwnProperty.call(SORTABLE, value);

/** The cap, applied to whatever was asked for. */
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 25;

export interface ListQuery {
  readonly limit?: number | undefined;
  readonly sort?: SortField | undefined;
  readonly direction?: SortDirection | undefined;
  /** Opaque to the caller; produced by a previous page. */
  readonly cursor?: string | undefined;
  /** Archived wines are hidden unless asked for (P1-09 exposes the choice). */
  readonly includeArchived?: boolean | undefined;
}

export interface ProductPage {
  readonly items: readonly ProductRow[];
  /** `null` on the last page — the client stops when it sees one. */
  readonly nextCursor: string | null;
}

/**
 * A cursor is the sort value and the id of the last row on a page.
 *
 * **Both, and the id is what makes it correct.** `created_at` is not unique —
 * a bulk import writes hundreds of rows in the same millisecond — so a cursor
 * carrying only the timestamp either repeats rows or skips them at every page
 * boundary, depending on which way the comparison rounds. The id breaks the tie
 * and is unique by construction.
 *
 * Base64 rather than a bare pair, because it is **not a contract**: a client
 * that parsed it would depend on the sort implementation, and adding a sort
 * column would then be a breaking change. Opaque means we can change it.
 *
 * **Each part is encoded separately and joined with a dot**, rather than joined
 * first and encoded once. A single encoding needs a separator that cannot occur
 * in either part — and the sort value can be a wine's *name*, which contains
 * spaces and very nearly anything else. A control character does the job and
 * puts one in the source file; encoding per part removes the question, because
 * `.` cannot appear in base64url output.
 */
const encodeCursor = (value: string, id: string): string =>
  [value, id].map((part) => Buffer.from(part, 'utf8').toString('base64url')).join('.');

interface Cursor {
  readonly value: string;
  readonly id: string;
}

export const decodeCursor = (cursor: string): Cursor | undefined => {
  const encoded = cursor.split('.');
  if (encoded.length !== 2) return undefined;

  const [value, id] = encoded.map((part) => Buffer.from(part, 'base64url').toString('utf8'));

  /*
   * `base64url` decoding does not reject rubbish — it skips what it cannot read
   * — so a malformed cursor arrives here as a short or empty string rather than
   * as an error. An empty id is the one that matters: it would make the tuple
   * boundary match nothing and hand back the first page for ever.
   */
  return value === undefined || id === undefined || id === '' ? undefined : { value, id };
};

/** The sort value of a row, as the string a cursor carries. */
const cursorValue = (row: ProductRow, sort: SortField): string => {
  const value = row[sort];
  return value instanceof Date ? value.toISOString() : String(value);
};

/**
 * One page of the catalogue, newest first by default.
 *
 * **Keyset, not `OFFSET`.** Offset degrades as the catalogue grows — the
 * database still walks the rows it is skipping — and, worse, it is *wrong* when
 * the data changes between pages: a row inserted while somebody is paging
 * shifts everything down by one, so page two repeats a row page one already
 * showed. On an import screen that is exactly when the data is changing.
 *
 * The comparison is a tuple: `(sortValue, id) < (cursorValue, cursorId)` for a
 * descending sort. Written out as `a < b OR (a = b AND id < cursorId)` rather
 * than as a row constructor, because the two sides are different types once the
 * sort column is a `text` or an `integer` and Drizzle has no portable tuple
 * comparison across them.
 */
export const listProducts = async (
  tx: DbTransaction,
  query: ListQuery = {},
): Promise<ProductPage> => {
  const sort: SortField = query.sort ?? 'createdAt';
  const direction: SortDirection = query.direction ?? 'desc';
  const column = SORTABLE[sort];

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const conditions: SQL[] = [];

  /*
   * Archived wines are hidden by default. A seller who removed a wine should
   * not have to look at it in their catalogue — and the row survives only so
   * that an order referring to it still makes sense (P1-04), which is not a
   * reason to show it.
   */
  if (query.includeArchived !== true) conditions.push(eq(products.status, 'ACTIVE'));

  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);

  if (cursor !== undefined) {
    const compare = direction === 'desc' ? lt : gt;
    const tie = direction === 'desc' ? lt(products.id, cursor.id) : gt(products.id, cursor.id);

    /*
     * `and` and `or` are typed as possibly-undefined because both accept empty
     * lists. Guarding rather than asserting keeps the impossible case impossible
     * instead of merely silenced — and a boundary that came out undefined would
     * quietly return the first page forever, which is the sort of bug a `!`
     * would have hidden.
     */
    const tieBreak = and(eq(column, cursor.value), tie);
    const boundary =
      tieBreak === undefined
        ? compare(column, cursor.value)
        : or(compare(column, cursor.value), tieBreak);

    if (boundary !== undefined) conditions.push(boundary);
  }

  const order = direction === 'desc' ? desc : asc;

  /*
   * One more row than asked for, which is how `nextCursor` is decided without a
   * second `count(*)` over the whole catalogue. A count would be a second scan
   * on every page for information the client does not need: it needs to know
   * whether to offer "next", not how many pages there are.
   */
  const rows = await tx
    .select()
    .from(products)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(order(column), order(products.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];

  return {
    items,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor(cursorValue(last, sort), last.id)
        : null,
  };
};
