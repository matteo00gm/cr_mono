/**
 * Public surface of `@catalogorosso/eval` (P1-45).
 *
 * The golden dataset that picks the pairing model and gates every prompt
 * change after it. Test-time only: production code may not import it.
 */
export {
  CATALOG_IDS,
  DATASET_DIR,
  InvalidDatasetError,
  loadDataset,
  parseDataset,
  QUERY_KINDS,
  type CatalogId,
  type EvalCatalog,
  type EvalDataset,
  type EvalQuery,
  type QueryKind,
} from './dataset.js';
