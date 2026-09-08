import { and, asc, desc, eq, lt, gt, or, sql, type SQL } from 'drizzle-orm';

import { products } from './schema/products.js';
import type { ProductRow } from './products.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * Catalogue reads (P1-06, P1-08).
 *
 * Separated from `products.ts` because the write path and the read path have
 * almost nothing in common and both will grow: search and filters (P1-09)
 * compose into the query builder here, and none of them touches the outbox
 * pairing that dominates the write file.
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
  /**
   * A search phrase (P1-08).
   *
   * When present it replaces the sort entirely: results come back by relevance,
   * because a search ordered by creation date is a filter wearing a search box.
   */
  readonly q?: string | undefined;
}

export interface ProductPage {
  readonly items: readonly ProductRow[];
  /** `null` on the last page — the client stops when it sees one. */
  readonly nextCursor: string | null;
  /**
   * How these rows were matched (P1-08).
   *
   * **Reported because a fallback that looks like an exact match is worse than
   * no results.** A seller searching for a producer they misspelled should be
   * told "nothing matched, here are similar wines" — otherwise they conclude
   * the catalogue contains something it does not, and the wrong conclusion is
   * the one the interface encouraged.
   */
  readonly matchedBy: MatchMode;
}

/**
 * How a page was matched, carried inside the cursor (P1-08).
 *
 * **The mode has to be in the cursor, and working out why is the interesting
 * part of the search design.** Search falls back to trigram similarity when the
 * text query matches nothing. But on page two the query is re-run *with a
 * boundary*, and an empty result then means "no more text matches" — which is
 * indistinguishable from "the text search never matched at all". Without the
 * mode, page two of a fallback result silently switches back to text and
 * returns nothing, so a misspelled search would show one page and then claim
 * there was no more.
 */
export type MatchMode = 'column' | 'text' | 'similar';

/**
 * A cursor is the match mode, the sort value, and the id of the last row shown.
 *
 * **The id is what makes it correct.** `created_at` is not unique — a bulk
 * import writes hundreds of rows in the same millisecond — so a cursor carrying
 * only the timestamp either repeats rows or skips them at every page boundary,
 * depending on which way the comparison rounds. The id breaks the tie and is
 * unique by construction. The same applies to a rank, which ties constantly.
 *
 * Base64 rather than a readable triple, because it is **not a contract**: a
 * client that parsed it would depend on the ranking function and the sort
 * implementation, and changing either would become a breaking change.
 *
 * **Each part is encoded separately and joined with a dot**, rather than joined
 * first and encoded once. A single encoding needs a separator that cannot occur
 * in any part — and the sort value can be a wine's *name*, which contains
 * spaces and very nearly anything else. A control character does the job and
 * puts one in the source file; encoding per part removes the question, because
 * `.` cannot appear in base64url output.
 */
const encodeCursor = (mode: MatchMode, value: string, id: string): string =>
  [mode, value, id].map((part) => Buffer.from(part, 'utf8').toString('base64url')).join('.');

interface Cursor {
  readonly mode: MatchMode;
  readonly value: string;
  readonly id: string;
}

const isMode = (value: string): value is MatchMode =>
  value === 'column' || value === 'text' || value === 'similar';

export const decodeCursor = (cursor: string): Cursor | undefined => {
  const encoded = cursor.split('.');
  if (encoded.length !== 3) return undefined;

  const [mode, value, id] = encoded.map((part) => Buffer.from(part, 'base64url').toString('utf8'));
  if (mode === undefined || value === undefined || id === undefined || id === '') return undefined;

  /*
   * `base64url` decoding does not reject rubbish — it skips what it cannot read
   * — so a malformed cursor arrives here as a short or empty string rather than
   * as an error. That is why the mode is checked against a closed set: it is
   * the only part whose value we know in advance.
   */
  return isMode(mode) ? { mode, value, id } : undefined;
};

/** The sort value of a row, as the string a cursor carries. */
const cursorValue = (row: ProductRow, sort: SortField): string => {
  const value = row[sort];
  return value instanceof Date ? value.toISOString() : String(value);
};

/**
 * The same value, back into what the *column* compares against.
 *
 * **A cursor is text and a column is not, so encoding needs a matching
 * decoding** — and getting that wrong does not produce a wrong page, it
 * produces a crash. Drizzle maps a bound parameter through the column's own
 * `mapToDriverValue`, so a string handed to a `timestamp` comparison reaches
 * `value.toISOString()` and throws. The integration suite is what found it:
 * page two of the *default* sort was a 500, and a fake transaction cannot see
 * that, because it never maps driver values.
 *
 * A table keyed by `SortField` rather than a `typeof` check, so adding a
 * sortable column is a compile error here until somebody says how its cursor
 * value comes back.
 */
export const CURSOR_DECODERS: Record<SortField, (value: string) => unknown> = {
  createdAt: (value) => new Date(value),
  updatedAt: (value) => new Date(value),
  name: (value) => value,
  priceCents: (value) => Number(value),
};

/**
 * One page of the catalogue, newest first by default.
 * The parsed query, and why it is `websearch_to_tsquery`.
 *
 * `to_tsquery` **throws** on the quotes, `&`, `|` and `!` that people type into
 * a search box — so a visitor searching for `Barolo "Bussia"` would get a 500
 * rather than a result, and the failure would look like a bug in the catalogue
 * rather than in the parser. `websearch_to_tsquery` reads that the way a search
 * engine would, and never raises.
 *
 * The phrase is unaccented on the way in for the same reason the column is on
 * the way out (P1-07): an index that only matches the stored spelling is an
 * index that works for whoever entered the data.
 */
const textQuery = (q: string): SQL =>
  sql`websearch_to_tsquery('italian', immutable_unaccent(${q}))`;

const textRank = (q: string): SQL<number> => sql<number>`ts_rank_cd(search_tsv, ${textQuery(q)})`;

/**
 * Similarity over the two fields people actually misspell.
 *
 * `greatest` rather than a sum, so a wine matching the producer well is not
 * outranked by one matching both fields badly.
 */
const similarityRank = (q: string): SQL<number> => sql<number>`greatest(
  similarity(immutable_unaccent(name), immutable_unaccent(${q})),
  similarity(immutable_unaccent(coalesce(producer, '')), immutable_unaccent(${q}))
)`;

/**
 * The similarity below which a row is not a match at all.
 *
 * Without a floor, `similarity` returns something for every row in the
 * catalogue and the fallback becomes "here is your whole catalogue, badly
 * ordered" — which is worse than no results, because it looks like an answer.
 */
const SIMILARITY_FLOOR = 0.2;

/** Conditions every page shares, whatever it is ordered by. */
const baseConditions = (query: ListQuery): SQL[] => {
  const conditions: SQL[] = [];

  /*
   * Archived wines are hidden by default. A seller who removed a wine should
   * not have to look at it in their catalogue — and the row survives only so
   * that an order referring to it still makes sense (P1-04), which is not a
   * reason to show it.
   */
  if (query.includeArchived !== true) conditions.push(eq(products.status, 'ACTIVE'));

  return conditions;
};

/**
 * The tuple boundary: `a < b OR (a = b AND id < cursorId)`.
 *
 * Written out rather than as a row constructor, because the two sides are
 * different types once the sort is a `text`, an `integer` or a computed rank,
 * and Drizzle has no portable tuple comparison across them.
 *
 * `and` and `or` are typed as possibly-undefined because both accept empty
 * lists. Guarding rather than asserting keeps the impossible case impossible
 * instead of merely silenced — a boundary that came out undefined would quietly
 * return the first page forever, which is the sort of bug a `!` would hide.
 */
const boundaryFor = (
  /*
   * Whatever `eq` itself accepts — a column or an expression. Naming the union
   * by hand would pin one of Drizzle's internal generic shapes and break on an
   * upgrade for no benefit.
   */
  sortExpression: Parameters<typeof eq>[0],
  value: unknown,
  cursorId: string,
  direction: SortDirection,
): SQL | undefined => {
  const compare = direction === 'desc' ? lt : gt;
  const tie = direction === 'desc' ? lt(products.id, cursorId) : gt(products.id, cursorId);
  const tieBreak = and(eq(sortExpression, value), tie);

  return tieBreak === undefined
    ? compare(sortExpression, value)
    : or(compare(sortExpression, value), tieBreak);
};

/**
 * A page ordered by one of the sortable columns (P1-06).
 *
 * **Keyset, not `OFFSET`.** Offset degrades as the catalogue grows — the
 * database still walks the rows it is skipping — and, worse, it is *wrong* when
 * the data changes between pages: a row inserted while somebody is paging
 * shifts everything down by one, so page two repeats a row page one already
 * showed. On an import screen that is exactly when the data is changing.
 */
const runColumnPage = async (
  tx: DbTransaction,
  query: ListQuery,
  limit: number,
  cursor: Cursor | undefined,
): Promise<ProductPage> => {
  const sort: SortField = query.sort ?? 'createdAt';
  const direction: SortDirection = query.direction ?? 'desc';
  const column = SORTABLE[sort];

  const conditions = baseConditions(query);

  if (cursor !== undefined) {
    const boundary = boundaryFor(column, CURSOR_DECODERS[sort](cursor.value), cursor.id, direction);
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
    matchedBy: 'column',
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor('column', cursorValue(last, sort), last.id)
        : null,
  };
};

/**
 * A ranked page, for a text search or for its similarity fallback (P1-08).
 *
 * The rank is selected alongside the row because the cursor has to carry it:
 * paging by relevance needs the boundary to be the rank of the last row shown,
 * and asking the client to recompute it would mean publishing the ranking
 * function as part of the API.
 *
 * **Relevance paging uses the same tuple shape as column paging**, with the
 * rank standing in for the column — so ordering and paging are one mechanism
 * rather than two that have to agree with each other.
 */
const runSearch = async (
  tx: DbTransaction,
  query: ListQuery,
  q: string,
  limit: number,
  mode: 'text' | 'similar',
  cursor: Cursor | undefined,
): Promise<ProductPage> => {
  const rank = mode === 'text' ? textRank(q) : similarityRank(q);

  const conditions = baseConditions(query);

  conditions.push(
    mode === 'text'
      ? sql`search_tsv @@ ${textQuery(q)}`
      : sql`${similarityRank(q)} >= ${SIMILARITY_FLOOR}`,
  );

  if (cursor !== undefined) {
    const boundary = boundaryFor(rank, Number(cursor.value), cursor.id, 'desc');
    if (boundary !== undefined) conditions.push(boundary);
  }

  const rows = await tx
    .select({ product: products, rank })
    .from(products)
    .where(and(...conditions))
    .orderBy(desc(rank), desc(products.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];

  return {
    items: items.map((row) => row.product),
    matchedBy: mode,
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor(mode, String(last.rank), last.product.id)
        : null,
  };
};

/**
 * One page of the catalogue — newest first, or by relevance when `q` is given.
 *
 * The fallback to trigram similarity happens **only on a first page**, and that
 * restriction is the subtle half. A later page that runs out of text matches
 * has simply ended; retrying it as a similarity search would append a second,
 * differently-ranked result set to the end of the first and repeat rows it had
 * already shown.
 */
export const listProducts = async (
  tx: DbTransaction,
  query: ListQuery = {},
): Promise<ProductPage> => {
  const q = query.q?.trim();
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  if (q === undefined || q === '') return runColumnPage(tx, query, limit, cursor);

  /*
   * The mode comes from the cursor when there is one. Re-deriving it would mean
   * asking "did the text search match?" of a query that already carries a
   * boundary, where an empty answer means "no more" rather than "never".
   */
  const mode = cursor?.mode === 'similar' ? 'similar' : 'text';

  const page = await runSearch(tx, query, q, limit, mode, cursor);

  if (page.items.length === 0 && cursor === undefined && mode === 'text') {
    return runSearch(tx, query, q, limit, 'similar', undefined);
  }

  return page;
};
