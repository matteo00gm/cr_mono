import type { ProductRequest, ProductsImportedResponse } from '@catalogorosso/api-client';

/**
 * An import too large for one request, sent as several (review fix, P1-25).
 *
 * The API stops an import between batches when its time budget runs out, and
 * answers like any stopped import: every row before `fromRow` applied, the rest
 * not started. The dashboard sends the rest by itself, as a new attempt, and
 * shows the seller one answer for the whole import. This file is that
 * bookkeeping, kept free of the screen so it can be tested on its own.
 */

/** The rows one request carries, and where each of them sits in the whole import. */
export interface ImportPart {
  readonly rows: readonly ProductRequest[];
  /** For each row sent, its index in the whole import. */
  readonly indexes: readonly number[];
}

type Counts = ProductsImportedResponse['counts'];

export const wholeImport = (rows: readonly ProductRequest[]): ImportPart => ({
  rows,
  indexes: rows.map((_, index) => index),
});

/**
 * What is left to send after a part's answer, or `null` when nothing is.
 *
 * Only a stop at the time budget continues. A failed batch is the seller's to
 * retry, as it always was, and a part that finished has nothing left.
 *
 * **Rows the part refused as repeated SKUs stay out.** The server finds repeats
 * among the rows it is sent, so a repeat whose twin was before the stop would
 * reach the next part on its own — and overwrite a wine the seller was told
 * would not be imported.
 */
export const remainderOf = (
  part: ImportPart,
  answer: ProductsImportedResponse,
): ImportPart | null => {
  if (answer.stoppedAt?.reason !== 'time-budget') return null;

  const refused = new Set(
    answer.outcomes.flatMap((outcome) =>
      outcome.outcome === 'duplicate-sku' ? [outcome.index] : [],
    ),
  );
  const from = answer.stoppedAt.fromRow - 1;

  const kept = part.rows.flatMap((row, index) => {
    const whole = part.indexes[index];
    return index >= from && !refused.has(index) && whole !== undefined ? [{ row, whole }] : [];
  });

  return kept.length === 0
    ? null
    : { rows: kept.map(({ row }) => row), indexes: kept.map(({ whole }) => whole) };
};

const add = (a: Counts, b: Counts): Counts => ({
  created: a.created + b.created,
  updated: a.updated + b.updated,
  unchanged: a.unchanged + b.unchanged,
  duplicateSku: a.duplicateSku + b.duplicateSku,
  archived: a.archived + b.archived,
});

/**
 * Every part's answer as one, numbered against the whole import.
 *
 * The counts add up because no row is counted twice: a part only ever carries
 * rows no earlier part applied or refused. Where the import stopped is the last
 * part's stop, renumbered, so the seller is told about lines of the list they saw.
 */
export const mergeAnswers = (
  earlier: ProductsImportedResponse | undefined,
  part: ImportPart,
  answer: ProductsImportedResponse,
): ProductsImportedResponse => {
  const whole = (index: number): number => part.indexes[index] ?? index;

  const outcomes = answer.outcomes.map((outcome) => ({ ...outcome, index: whole(outcome.index) }));
  const stoppedAt =
    answer.stoppedAt === null
      ? null
      : {
          ...answer.stoppedAt,
          fromRow: whole(answer.stoppedAt.fromRow - 1) + 1,
          toRow: whole(answer.stoppedAt.toRow - 1) + 1,
        };

  if (earlier === undefined) return { outcomes, counts: answer.counts, stoppedAt };

  return {
    outcomes: [...earlier.outcomes, ...outcomes].sort((a, b) => a.index - b.index),
    counts: add(earlier.counts, answer.counts),
    stoppedAt,
  };
};

/** Rows that reached the catalogue so far, for the progress line. */
export const appliedCount = (answer: ProductsImportedResponse): number =>
  answer.counts.created + answer.counts.updated + answer.counts.unchanged;
