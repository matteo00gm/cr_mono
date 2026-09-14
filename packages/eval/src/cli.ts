import process from 'node:process';

import { loadDataset } from './dataset.js';
import { runEval } from './harness.js';
import { providerFromEnv } from './providers.js';
import { formatReport } from './report.js';
import { lexicalRetriever } from './retriever.js';
import { humanSample } from './rubric.js';

/**
 * `pnpm eval`: one provider, the whole dataset, twice (P1-46).
 *
 * **Opt-in by construction.** No test imports this file, it needs credentials
 * from your own shell, and it costs money — see `providerFromEnv` for what it
 * reads. Two runs, because the table's spread column is what says whether a
 * difference between providers is a finding.
 *
 * It retrieves with the lexical stand-in until P2-20 exists, so its recall
 * columns describe the stand-in; the generation columns are the provider's.
 */

const HUMAN_SAMPLE_SIZE = 12;

const provider = providerFromEnv(process.env);
const dataset = loadDataset();

const first = await runEval({ dataset, provider, retriever: lexicalRetriever });
const second = await runEval({ dataset, provider, retriever: lexicalRetriever });

process.stdout.write(
  [
    formatReport([{ provider: provider.id, runs: [first.summary, second.summary] }]),
    '',
    `Reserved for human rating: ${humanSample(dataset.queries, HUMAN_SAMPLE_SIZE)
      .map((query) => query.id)
      .join(', ')}`,
    '',
  ].join('\n'),
);
