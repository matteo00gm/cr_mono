/**
 * Public surface of `@catalogorosso/eval` (P1-45, P1-46).
 *
 * The golden dataset that picks the pairing model and gates every prompt
 * change after it, and the harness that scores a provider against it.
 * Test-time only: production code may not import it.
 *
 * `providers.ts` and `cli.ts` are deliberately not re-exported: they load every
 * vendor SDK, and only `pnpm eval` needs them.
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

export { fakeLlmProvider, type FakeLlmOptions, type FakeLlmProvider } from './fake-llm-provider.js';

export { runEval, type EvalOptions, type EvalRun } from './harness.js';

export {
  CANDIDATE_LIMIT,
  firstHitRank,
  SCHEMA_FAILURE_CEILING,
  summarise,
  type EvalSummary,
  type Outcome,
  type QueryResult,
} from './metrics.js';

export { formatReport, runToRunSpread, type ProviderRuns } from './report.js';

export { lexicalRetriever, terms, type Retriever } from './retriever.js';

export {
  humanSample,
  PAIRING_RUBRIC,
  type Judge,
  type JudgeInput,
  type JudgeVerdict,
} from './rubric.js';

export { seedCatalogs, toCandidate, type SeededCatalog, type SeededProduct } from './seed.js';
