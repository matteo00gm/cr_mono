import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CATALOG_IDS,
  InvalidDatasetError,
  loadDataset,
  parseDataset,
  QUERY_KINDS,
  type EvalDataset,
} from '../src/dataset.js';

/**
 * The golden eval dataset (P1-45).
 *
 * The row's tests — a schema test on the dataset, and every referenced product
 * exists in its catalogue — plus the checks that catch a wrong label before it
 * mis-scores a model: a price limit every labelled wine meets, a colour every
 * labelled wine has, and a sparse catalogue that really is sparse.
 */

const dataset: EvalDataset = loadDataset();

const catalog = (id: string) => {
  const found = dataset.catalogs.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no catalog ${id}`);
  return found;
};

const WINE = {
  sku: 'X-1',
  name: 'Vino di prova',
  wineType: 'rosso',
  priceCents: 1000,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
};

const QUERY = {
  id: 'q01',
  catalog: 'broad',
  kind: 'dish',
  locale: 'it',
  query: 'brasato',
  acceptable: ['X-1'],
  rationale: 'A red for a braise, labelled for the test.',
};

const files = (over: { products?: unknown[]; queries?: unknown[] } = {}) => ({
  catalogs: {
    version: 1,
    catalogs: [{ id: 'broad', description: 'Test catalogue.', products: over.products ?? [WINE] }],
  },
  queries: { version: 1, queries: over.queries ?? [QUERY] },
});

const problemsOf = (catalogsJson: unknown, queriesJson: unknown): readonly string[] => {
  try {
    parseDataset(catalogsJson, queriesJson);
  } catch (error) {
    if (error instanceof InvalidDatasetError) return error.problems;
    throw error;
  }
  throw new Error('expected the dataset to be refused');
};

describe('the committed dataset', () => {
  it('loads, every wine satisfying the product contract and every label naming a stocked wine', () => {
    expect(dataset.catalogs.map((entry) => entry.id)).toEqual([...CATALOG_IDS]);
  });

  it('has three catalogues of forty wines and sixty queries', () => {
    expect(dataset.catalogs.map((entry) => entry.products.length)).toEqual([40, 40, 40]);
    expect(dataset.queries).toHaveLength(60);
  });

  it('covers every kind of question, mostly in Italian, with honest dead ends', () => {
    for (const kind of QUERY_KINDS) {
      expect(dataset.queries.filter((query) => query.kind === kind).length, kind).toBeGreaterThan(
        3,
      );
    }
    expect(dataset.queries.filter((query) => query.locale === 'it').length).toBeGreaterThanOrEqual(
      50,
    );
    expect(
      dataset.queries.filter((query) => query.acceptable.length === 0).length,
    ).toBeGreaterThanOrEqual(5);
  });

  it('prices every wine a price-limited query accepts under that limit', () => {
    const limited = dataset.queries.filter((query) => /(sotto i|under) \d+ euro/.test(query.query));
    expect(limited.length).toBeGreaterThanOrEqual(5);

    for (const query of limited) {
      const limit = Number(/(\d+) euro/.exec(query.query)?.[1]) * 100;
      const stocked = catalog(query.catalog).products;

      for (const sku of query.acceptable) {
        const wine = stocked.find((product) => product.sku === sku);
        expect(wine?.priceCents, `${query.id} ${sku}`).toBeLessThan(limit);
      }
    }
  });

  it('accepts only the colour a query asks for, where it names one', () => {
    const coloured = dataset.queries.filter((entry) =>
      /\bun (rosso|bianco|rosato)\b/.test(entry.query),
    );
    expect(coloured.length).toBeGreaterThanOrEqual(3);

    for (const query of coloured) {
      const colour = /\bun (rosso|bianco|rosato)\b/.exec(query.query)?.[1];
      const stocked = catalog(query.catalog).products;

      for (const sku of query.acceptable) {
        expect(stocked.find((product) => product.sku === sku)?.wineType, `${query.id} ${sku}`).toBe(
          colour,
        );
      }
    }
  });

  it('keeps the sparse catalogue sparse: name, type and price, and nothing a model could reason from', () => {
    for (const wine of catalog('sparse').products) {
      expect(wine.tastingNotes ?? null).toBeNull();
      expect(wine.foodPairings ?? null).toBeNull();
      expect(wine.grapeVarieties ?? null).toBeNull();
    }
  });

  it('keeps the Piedmont catalogue in Piedmont', () => {
    expect(new Set(catalog('piemonte').products.map((wine) => wine.region))).toEqual(
      new Set(['Piemonte']),
    );
  });
});

describe('parseDataset', () => {
  it('accepts a minimal valid dataset', () => {
    const { catalogs, queries } = files();

    expect(parseDataset(catalogs, queries).queries).toHaveLength(1);
  });

  it('refuses files of the wrong shape, naming which file', () => {
    const problems = problemsOf({ version: 2, catalogs: [] }, { version: 1, queries: 'none' });

    expect(problems.some((problem) => problem.startsWith('catalogs.version'))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('queries.queries'))).toBe(true);
  });

  it('refuses a rationale too short to be an argument', () => {
    const { catalogs, queries } = files({ queries: [{ ...QUERY, rationale: 'Rosso.' }] });

    expect(problemsOf(catalogs, queries).some((problem) => problem.includes('rationale'))).toBe(
      true,
    );
  });

  it('refuses a wine that could not be seeded, and reports every problem at once', () => {
    const { catalogs, queries } = files({
      products: [{ ...WINE, priceCents: -1 }, WINE, WINE],
      queries: [QUERY, { ...QUERY, acceptable: ['NOPE'] }],
    });

    const problems = problemsOf(catalogs, queries);

    expect(
      problems.some((problem) => problem.startsWith('broad[0] breaks the product contract')),
    ).toBe(true);
    expect(problems).toContain('broad: SKU X-1 appears twice');
    expect(problems).toContain('query q01 appears twice');
    expect(problems).toContain('q01 accepts NOPE, which broad does not stock');
  });

  it('refuses a catalogue named twice, and a query naming a catalogue that is not there', () => {
    const catalogs = {
      version: 1,
      catalogs: [
        { id: 'broad', description: 'One.', products: [WINE] },
        { id: 'broad', description: 'Two.', products: [WINE] },
      ],
    };
    const queries = { version: 1, queries: [{ ...QUERY, catalog: 'sparse' }] };

    const problems = problemsOf(catalogs, queries);

    expect(problems).toContain('catalog broad appears twice');
    expect(problems).toContain('q01 names catalog sparse, which the dataset does not have');
  });

  it('refuses a label listing a SKU twice', () => {
    const { catalogs, queries } = files({ queries: [{ ...QUERY, acceptable: ['X-1', 'X-1'] }] });

    expect(problemsOf(catalogs, queries)).toContain('q01 lists an acceptable SKU twice');
  });

  it.each([
    ['an unanswerable query that accepts a wine', { kind: 'unanswerable' }],
    ['an answerable query that accepts nothing', { acceptable: [] }],
  ])('refuses %s', (_case, over) => {
    const { catalogs, queries } = files({ queries: [{ ...QUERY, ...over }] });

    expect(problemsOf(catalogs, queries)).toContain(
      'q01: only an unanswerable query may accept nothing, and it must',
    );
  });
});

describe('loadDataset', () => {
  it('reads the two files from the directory it is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-eval-'));
    const { catalogs, queries } = files();
    writeFileSync(join(dir, 'catalogs.json'), JSON.stringify(catalogs));
    writeFileSync(join(dir, 'queries.json'), JSON.stringify(queries));

    expect(loadDataset(dir).queries.map((query) => query.id)).toEqual(['q01']);
  });
});
