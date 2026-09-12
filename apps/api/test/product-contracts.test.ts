import { productRequest, productSchema } from '@catalogorosso/api-client';
import { productInsert, productSelect } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

/**
 * The published product shapes, kept honest against the derived ones (P1-01).
 *
 * **`packages/api-client` cannot import `packages/db`, and that is the whole
 * reason this file exists.** The client package depends on `zod` and nothing
 * else, deliberately: the dashboard and the widget bundle it, and importing the
 * table contracts would pull `drizzle-orm` and the schema into a browser. So
 * the wire shapes are written by hand there — which is a departure from "refine,
 * never redefine" (P0-42) and is only safe if something checks the two agree.
 *
 * This is that something. `apps/api` is where both are importable, so the
 * assertion lives here rather than in either package.
 *
 * It catches the failure that has no other symptom: a column renamed in the
 * schema leaves a response field nothing fills, and every existing test keeps
 * passing because the fake still produces the old key.
 */

const keysOf = (schema: { shape: Record<string, unknown> }): string[] =>
  Object.keys(schema.shape).sort();

/**
 * Fields the response carries that are not columns.
 *
 * **An explicit list, because "it is computed" is exactly what somebody would
 * say about a field they forgot to fill.** The check above is what catches a
 * column renamed in the schema leaving a response field nothing writes — so an
 * escape from it has to be one line per field with a reason, not a predicate
 * that lets any new key through.
 */
const DERIVED_FIELDS: Readonly<Record<string, string>> = {
  completeness:
    'P1-12. A weighted score over the columns beside it, computed by ' +
    '`completenessOf` rather than stored — the weights are a product decision ' +
    'that gets tuned, and a stored column would mean a table rewrite each time. ' +
    'Sent rather than left to the client because P1-09 filters by it in SQL, and ' +
    'a client that recomputed could disagree with what was filtered.',
};

describe('the published product shape', () => {
  it('names only columns the table actually has, or a declared derived field', () => {
    const published = keysOf(productSchema);
    const columns = new Set(keysOf(productSelect));

    const strays = published.filter(
      (key) => !columns.has(key) && !Object.hasOwn(DERIVED_FIELDS, key),
    );

    expect(strays).toEqual([]);
  });

  it('keeps the derived list honest', () => {
    /*
     * Two ways this escape hatch rots, and both leave it looking used. A field
     * listed here that *is* a column no longer needs the exemption and is now
     * hiding that column from the check above. A field listed with no reason is
     * an exemption nobody can evaluate.
     */
    const columns = new Set(keysOf(productSelect));
    const published = new Set(keysOf(productSchema));

    for (const [field, reason] of Object.entries(DERIVED_FIELDS)) {
      expect(published.has(field), `${field} is declared derived but is not published`).toBe(true);
      expect(columns.has(field), `${field} is a real column and needs no exemption`).toBe(false);
      expect(reason.length, `${field} has no reason`).toBeGreaterThan(40);
    }
  });

  it('publishes every column a client could need, and states what it withholds', () => {
    /*
     * The inverse direction, written as an explicit list rather than an
     * assertion that everything is published — because *not* publishing a
     * column is a decision each time, and this is where it gets recorded.
     */
    const withheld = keysOf(productSelect).filter((key) => !keysOf(productSchema).includes(key));

    expect(withheld).toEqual([
      /*
       * An internal cost control. A client that could see it would eventually
       * branch on it, turning a change in how it is computed into a breaking
       * API change instead of a re-index (P1-02).
       */
      'contentHash',
      /*
       * The provider's own words, and operator-facing rather than
       * seller-facing: "ValidationException" tells a winery nothing it can act
       * on. **P1-50 owns turning it into something that does**, and publishing
       * the raw text before then would set a contract around a string we intend
       * to replace.
       */
      'embeddingAttempts',
      'embeddingError',
      /*
       * Not secret — the caller knows which winery they are in — but publishing
       * a field the contract does not declare invites a client to depend on it,
       * which is the same problem one step later.
       */
      'tenantId',
    ]);
  });
});

describe('the request shape', () => {
  it('accepts exactly the fields the server contract accepts', () => {
    /*
     * The form validates against a hand-written schema in the browser, and the
     * server validates against the derived one. **They have to agree, and
     * nothing but this makes them.** A field the form offers and the server
     * strips is a value a seller typed and lost, with no error to explain it.
     */
    expect(keysOf(productRequest)).toEqual(keysOf(productInsert));
  });

  it('requires exactly what the server requires', () => {
    /*
     * Keys agreeing is not enough. A field optional in the browser and required
     * on the server is a 422 the form could have caught; required in the
     * browser and optional on the server is a wine somebody cannot save for a
     * reason that is not real.
     */
    const requiredIn = (schema: {
      shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    }) =>
      Object.entries(schema.shape)
        .filter(([, field]) => !field.safeParse(undefined).success)
        .map(([key]) => key)
        .sort();

    expect(requiredIn(productRequest)).toEqual(requiredIn(productInsert));
  });
});
