import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { productInsert, type ProductInsert } from '@catalogorosso/db';
import { z } from 'zod';

/**
 * The golden Italian eval dataset (P1-45).
 *
 * **The instrument that picks the model, and the regression gate for every
 * prompt change after it** — so its quality caps the quality of every decision
 * taken with it. Three synthetic catalogues of forty wines each (a broad one,
 * a Piedmont-only one, a sparsely described one) and sixty labelled queries.
 *
 * **A label is a set of SKUs with a rationale**, never a single right answer:
 * several wines are legitimately correct for "carne di maiale alla griglia",
 * and a future maintainer has to be able to argue with a label, which a bare
 * id list does not let them do. SKUs rather than product ids, because the
 * harness seeds a real database and the database assigns the ids.
 *
 * The data is JSON beside this package, and it is validated on every load: a
 * wine that does not satisfy the real product contract could not be seeded,
 * and a label naming a SKU the catalogue lacks would score every model as
 * wrong for the dataset's mistake.
 */

export const CATALOG_IDS = ['broad', 'piemonte', 'sparse'] as const;
export type CatalogId = (typeof CATALOG_IDS)[number];

export const QUERY_KINDS = ['dish', 'constraint', 'vague', 'lookup', 'unanswerable'] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

export interface EvalCatalog {
  readonly id: CatalogId;
  readonly description: string;
  readonly products: readonly ProductInsert[];
}

export interface EvalQuery {
  readonly id: string;
  readonly catalog: CatalogId;
  readonly kind: QueryKind;
  readonly locale: 'it' | 'en';
  readonly query: string;
  /** Every SKU that is a correct recommendation. Empty exactly when the catalogue cannot answer. */
  readonly acceptable: readonly string[];
  readonly rationale: string;
}

export interface EvalDataset {
  readonly catalogs: readonly EvalCatalog[];
  readonly queries: readonly EvalQuery[];
}

export class InvalidDatasetError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`The eval dataset is invalid:\n  ${problems.join('\n  ')}`);
    this.name = 'InvalidDatasetError';
    this.problems = problems;
  }
}

const catalogsFile = z.object({
  version: z.literal(1),
  catalogs: z.array(
    z.object({
      id: z.enum(CATALOG_IDS),
      description: z.string().min(1),
      products: z.array(z.unknown()).min(1),
    }),
  ),
});

const queriesFile = z.object({
  version: z.literal(1),
  queries: z.array(
    z.object({
      id: z.string().regex(/^q\d{2}$/),
      catalog: z.enum(CATALOG_IDS),
      kind: z.enum(QUERY_KINDS),
      locale: z.enum(['it', 'en']),
      query: z.string().min(1),
      acceptable: z.array(z.string().min(1)),
      /** Long enough to be an argument, not a label restated. */
      rationale: z.string().min(20),
    }),
  ),
});

const issuesOf = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`);

/**
 * Validates the two files' contents and cross-checks them.
 *
 * Every problem is collected before throwing, so a maintainer fixing a label
 * sees all of them at once rather than one per run.
 */
export const parseDataset = (catalogsJson: unknown, queriesJson: unknown): EvalDataset => {
  const catalogsParsed = catalogsFile.safeParse(catalogsJson);
  const queriesParsed = queriesFile.safeParse(queriesJson);

  if (!catalogsParsed.success || !queriesParsed.success) {
    throw new InvalidDatasetError([
      ...(catalogsParsed.success ? [] : issuesOf(catalogsParsed.error).map((p) => `catalogs.${p}`)),
      ...(queriesParsed.success ? [] : issuesOf(queriesParsed.error).map((p) => `queries.${p}`)),
    ]);
  }

  const problems: string[] = [];
  const catalogs: EvalCatalog[] = [];
  const skusByCatalog = new Map<CatalogId, Set<string>>();

  for (const catalog of catalogsParsed.data.catalogs) {
    if (skusByCatalog.has(catalog.id)) problems.push(`catalog ${catalog.id} appears twice`);

    const skus = new Set<string>();
    const products: ProductInsert[] = [];

    catalog.products.forEach((raw, index) => {
      const product = productInsert.safeParse(raw);
      if (!product.success) {
        problems.push(
          `${catalog.id}[${String(index)}] breaks the product contract: ${issuesOf(product.error).join('; ')}`,
        );
        return;
      }

      if (skus.has(product.data.sku))
        problems.push(`${catalog.id}: SKU ${product.data.sku} appears twice`);
      skus.add(product.data.sku);
      products.push(product.data);
    });

    skusByCatalog.set(catalog.id, skus);
    catalogs.push({ id: catalog.id, description: catalog.description, products });
  }

  const queryIds = new Set<string>();

  for (const query of queriesParsed.data.queries) {
    if (queryIds.has(query.id)) problems.push(`query ${query.id} appears twice`);
    queryIds.add(query.id);

    const skus = skusByCatalog.get(query.catalog);
    if (skus === undefined) {
      problems.push(`${query.id} names catalog ${query.catalog}, which the dataset does not have`);
      continue;
    }

    for (const sku of query.acceptable) {
      if (!skus.has(sku))
        problems.push(`${query.id} accepts ${sku}, which ${query.catalog} does not stock`);
    }

    if (new Set(query.acceptable).size !== query.acceptable.length) {
      problems.push(`${query.id} lists an acceptable SKU twice`);
    }

    // An unanswerable query accepts nothing, and nothing else may: an empty set
    // anywhere else would score every honest "no" as correct for the wrong reason.
    if ((query.kind === 'unanswerable') !== (query.acceptable.length === 0)) {
      problems.push(`${query.id}: only an unanswerable query may accept nothing, and it must`);
    }
  }

  if (problems.length > 0) throw new InvalidDatasetError(problems);

  return { catalogs, queries: queriesParsed.data.queries };
};

/** Where the committed dataset lives: beside `src/` and `dist/`, so both find it. */
export const DATASET_DIR = join(import.meta.dirname, '..', 'dataset');

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;

/** Loads and validates the committed dataset. */
export const loadDataset = (dir: string = DATASET_DIR): EvalDataset =>
  parseDataset(readJson(join(dir, 'catalogs.json')), readJson(join(dir, 'queries.json')));
