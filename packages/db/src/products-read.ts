import { and, asc, desc, eq, gte, lt, gt, lte, or, sql, type SQL } from 'drizzle-orm';

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

  /* ---- filters (P1-09) ------------------------------------------------- */

  readonly stockStatus?: StockStatus | undefined;
  /**
   * An exact match on a free-text column, deliberately.
   *
   * `wine_type` is `text` rather than an enum (P0-26): the taxonomy grows
   * sideways — orange, pét-nat, col fondo — and each addition would otherwise
   * be an `ALTER TYPE` for a label that guards nothing. So this cannot be
   * validated against a Zod enum the way the row assumes; it is a bounded
   * string, matched exactly, and the value comes from the facet list a screen
   * builds out of the catalogue itself.
   */
  readonly wineType?: string | undefined;
  /**
   * A grape the wine must contain (P1-07, P1-09).
   *
   * **Containment, and it carries more weight than the other filters**, because
   * free-text search cannot answer it: `array_to_string` is `STABLE`, so the
   * grape array could not be folded into the generated tsvector and "find me a
   * nebbiolo" has nowhere else to go. The array GIN index is what makes it
   * cheap.
   */
  readonly grape?: string | undefined;
  /** Minor units, inclusive, like every price in this system. */
  readonly priceMin?: number | undefined;
  readonly priceMax?: number | undefined;
  readonly embeddingState?: EmbeddingState | undefined;

  /**
   * How completely a wine is described (P1-09, deferred there until P1-12).
   *
   * **The weights come from the caller, the columns from this package**, and
   * the split is the point. `packages/core` owns what a field is worth — it is
   * a product decision, tuned against how retrieval behaves — and this package
   * owns which column holds it. Neither can import the other (`core` already
   * depends on `db`, so the reverse is a cycle), so the API layer, which
   * imports both, joins them.
   *
   * The alternative was writing the weights again in SQL, which is the failure
   * `completeness.ts` opens by naming: a score computed twice by two
   * implementations is a score that disagrees with itself in front of the
   * seller.
   */
  readonly completeness?: CompletenessFilter | undefined;
}

/** One scored field, named as `packages/core` names it. */
export interface CompletenessWeight {
  readonly field: string;
  readonly weight: number;
}

export interface CompletenessFilter {
  /** Inclusive, 0-100. Both optional, like the price range. */
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly weights: readonly CompletenessWeight[];
}

/**
 * Which column holds each scored field, and how "filled in" is decided for it.
 *
 * **Presence has to mean the same thing here as in `isPresent`**, or a wine
 * scores 60 in the grid and is excluded by a filter for 40-74. So each entry
 * spells out the SQL rather than sharing one rule: an empty array and an empty
 * string are both *absent*, and they are absent in different syntax.
 */
const COMPLETENESS_COLUMNS: Readonly<Record<string, SQL>> = {
  // `coalesce(array_length(...), 1)`: array_length is NULL for an empty array,
  // which would make `> 0` NULL rather than false — and a NULL in a CASE goes
  // to ELSE, which happens to be right and for the wrong reason. Written so it
  // is right on purpose.
  foodPairings: sql`coalesce(array_length(${products.foodPairings}, 1), 0) > 0`,
  grapeVarieties: sql`coalesce(array_length(${products.grapeVarieties}, 1), 0) > 0`,
  styleTags: sql`coalesce(array_length(${products.styleTags}, 1), 0) > 0`,

  // `btrim` because whitespace is absent: a tasting note of three spaces
  // describes nothing, and rewarding it makes the score gameable by accident.
  tastingNotes: sql`btrim(coalesce(${products.tastingNotes}, '')) <> ''`,
  region: sql`btrim(coalesce(${products.region}, '')) <> ''`,
  denomination: sql`btrim(coalesce(${products.denomination}, '')) <> ''`,
  producer: sql`btrim(coalesce(${products.producer}, '')) <> ''`,

  // Numbers: present means not null. Zero is a value, which matters the day a
  // wine is a non-vintage labelled 0 rather than left blank.
  vintage: sql`${products.vintage} is not null`,
  alcoholPct: sql`${products.alcoholPct} is not null`,
};

/**
 * The score, as an expression the database can filter and sort by.
 *
 * Rounded the same way `completenessOf` rounds, because the two numbers are
 * shown side by side: the grid displays what the API computed in TypeScript and
 * filters by what Postgres computed here, and a wine sitting exactly on a band
 * boundary must land in the same band both times.
 */
export const completenessExpression = (weights: readonly CompletenessWeight[]): SQL => {
  const total = weights.reduce((sum, { weight }) => sum + weight, 0);

  if (total <= 0) {
    throw new Error(
      'completeness weights sum to zero, so every wine would score the same. This is a ' +
        'caller passing an empty or malformed weight list (P1-09).',
    );
  }

  const terms = weights.map(({ field, weight }) => {
    const present = COMPLETENESS_COLUMNS[field];

    if (present === undefined) {
      /*
       * A field scored in `packages/core` with no column here. Thrown rather
       * than skipped: silently ignoring it would lower every wine's score by
       * that weight, and the catalogue would quietly re-band itself.
       */
      throw new Error(
        `completeness scores "${field}", which has no column in products-read.ts. ` +
          'Add it to COMPLETENESS_COLUMNS, or the score here and the score the API ' +
          'computes will disagree (P1-09).',
      );
    }

    return sql`(case when ${present} then ${weight} else 0 end)`;
  });

  return sql`round(((${sql.join(terms, sql` + `)})::numeric * 100) / ${total})`;
};

/** The stock states from P0-26, as the filter accepts them. */
export const STOCK_STATUSES = ['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

/** Where a row sits in the embedding pipeline. */
export const EMBEDDING_STATES = ['PENDING', 'INDEXED', 'FAILED', 'STALE'] as const;
export type EmbeddingState = (typeof EMBEDDING_STATES)[number];

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

/**
 * The type each sort column's cursor value is cast back to, in SQL.
 *
 * **The cursor is text and the column is not, so the comparison needs a cast —
 * and the cast has to happen in Postgres rather than in JavaScript.** Two
 * failures got here first, both found by the integration suite:
 *
 * - Handing the raw string to a `timestamp` comparison throws inside Drizzle's
 *   own driver mapping.
 * - Converting it back to a JS `Date` fixes that and breaks paging, because a
 *   `Date` holds **milliseconds** and a `timestamptz` holds **microseconds**.
 *   The cursor then names an instant slightly *before* the row it came from:
 *   descending, the boundary excludes every remaining row and paging stops
 *   after two pages; ascending, it excludes nothing and never terminates.
 *
 * Casting in SQL sidesteps both. Postgres renders the value with full precision
 * and parses it back exactly, and the comparison is still against the bare
 * column, so the index is still usable.
 */
const CURSOR_CASTS: Record<SortField, string> = {
  createdAt: 'timestamptz',
  updatedAt: 'timestamptz',
  name: 'text',
  priceCents: 'integer',
};

/**
 * The sort value as Postgres itself renders it, selected alongside the row.
 *
 * Selected rather than derived from `ProductRow`, because the row has already
 * lost precision by the time JavaScript holds it — see the note above.
 */
const sortValueOf = (sort: SortField): SQL<string> => sql<string>`${SORTABLE[sort]}::text`;

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
 * **The phrase is not unaccented, because the column is not either** — Postgres
 * refuses `unaccent` in a generated column three different ways, and the last
 * of them needs superuser (P1-07). So an accented spelling misses here and is
 * caught by the similarity fallback below, which is reported to the caller as
 * `matchedBy: 'similar'` rather than passed off as an exact hit.
 */
const textQuery = (q: string): SQL => sql`websearch_to_tsquery('italian', ${q})`;

const textRank = (q: string): SQL<number> => sql<number>`ts_rank_cd(search_tsv, ${textQuery(q)})`;

/**
 * Similarity over the two fields people actually misspell.
 *
 * `greatest` rather than a sum, so a wine matching the producer well is not
 * outranked by one matching both fields badly.
 *
 * This is also where **accented spellings** land, since the stored vector
 * cannot fold them (P1-07): `nebbiolo` against a stored `Nebbiòlo` misses the
 * tsquery and scores high here.
 */
const similarityRank = (q: string): SQL<number> => sql<number>`greatest(
  similarity(name, ${q}),
  similarity(coalesce(producer, ''), ${q})
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

  /*
   * **Composed into the same builder rather than given their own query path**,
   * which is the row's real requirement: a second code path would work for the
   * list and quietly not for the search, and the bug would be "filters do
   * nothing when you type in the box" — reported by a seller, months later.
   * Every page above shares these conditions by construction.
   */
  if (query.stockStatus !== undefined) {
    conditions.push(eq(products.stockStatus, query.stockStatus));
  }

  if (query.wineType !== undefined) conditions.push(eq(products.wineType, query.wineType));

  /*
   * `@>` rather than `= ANY`, because containment is what the GIN index
   * answers — and the index is the whole reason this filter is affordable on a
   * catalogue of any size.
   */
  if (query.grape !== undefined) {
    conditions.push(sql`${products.grapeVarieties} @> array[${query.grape}]::text[]`);
  }

  if (query.embeddingState !== undefined) {
    conditions.push(eq(products.embeddingState, query.embeddingState));
  }

  /*
   * Inclusive at both ends, and independently optional so "under 20 euro" needs
   * no invented floor. A range with the bounds the wrong way round returns
   * nothing rather than erroring: it is a slider dragged past itself, not a
   * malformed request, and the honest answer is an empty result.
   */
  if (query.priceMin !== undefined) conditions.push(gte(products.priceCents, query.priceMin));
  if (query.priceMax !== undefined) conditions.push(lte(products.priceCents, query.priceMax));

  /*
   * Computed per row rather than stored. A generated column would be free to
   * filter and index, and would put the weights in a migration — a third place
   * for them to disagree, and a table rewrite every time a product decision is
   * tuned. At this catalogue size the expression is cheap; revisit if a seller
   * ever has enough wines for it to matter, which is a different problem from
   * the one this solves.
   */
  if (query.completeness !== undefined) {
    const score = completenessExpression(query.completeness.weights);

    if (query.completeness.min !== undefined) {
      conditions.push(sql`${score} >= ${query.completeness.min}`);
    }

    if (query.completeness.max !== undefined) {
      conditions.push(sql`${score} <= ${query.completeness.max}`);
    }
  }

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
/**
 * The column boundary, with the cursor value cast by Postgres.
 *
 * Written as raw `sql` rather than through `boundaryFor` because the value has
 * to reach the database as text and be cast there — see `CURSOR_CASTS`. The
 * ranked boundary below keeps using `boundaryFor`, because a rank is a number
 * on both sides and has no precision to lose.
 */
const columnBoundary = (sort: SortField, cursor: Cursor, direction: SortDirection): SQL => {
  const column = SORTABLE[sort];
  const at = sql`${cursor.value}::${sql.raw(CURSOR_CASTS[sort])}`;
  const compare = direction === 'desc' ? sql`<` : sql`>`;

  return sql`(${column} ${compare} ${at} or (${column} = ${at} and ${products.id} ${compare} ${cursor.id}::uuid))`;
};

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
    conditions.push(columnBoundary(sort, cursor, direction));
  }

  const order = direction === 'desc' ? desc : asc;

  /*
   * One more row than asked for, which is how `nextCursor` is decided without a
   * second `count(*)` over the whole catalogue. A count would be a second scan
   * on every page for information the client does not need: it needs to know
   * whether to offer "next", not how many pages there are.
   */
  const rows = await tx
    .select({ product: products, sortValue: sortValueOf(sort) })
    .from(products)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(order(column), order(products.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const last = items[items.length - 1];

  return {
    items: items.map((row) => row.product),
    matchedBy: 'column',
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor('column', last.sortValue, last.product.id)
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
