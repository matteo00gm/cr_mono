import { randomUUID } from 'node:crypto';

import type { LlmProvider, PairingChunk, PairingRequest } from '@catalogorosso/core';
import { describe, expect, it, vi } from 'vitest';

import { loadDataset, type EvalDataset } from '../src/dataset.js';
import { fakeLlmProvider } from '../src/fake-llm-provider.js';
import { runEval } from '../src/harness.js';
import { CANDIDATE_LIMIT } from '../src/metrics.js';
import { formatReport } from '../src/report.js';
import { lexicalRetriever, type Retriever } from '../src/retriever.js';
import type { Judge } from '../src/rubric.js';

/**
 * The eval harness (P1-46).
 *
 * The row's test — the harness runs against the fake provider deterministically
 * in CI — plus the scoring rules a real run depends on: a recommendation scores
 * only through the candidates the model was given, schema failures count
 * against the provider, and the judge sees exactly what the model saw.
 */

const dataset = loadDataset();

const only = (...ids: string[]): EvalDataset => ({
  catalogs: dataset.catalogs,
  queries: dataset.queries.filter((query) => ids.includes(query.id)),
});

const scripted = (respond: (request: PairingRequest) => readonly PairingChunk[]) =>
  fakeLlmProvider({ id: 'scripted', respond });

/** Every wine, in catalogue order. */
const everything: Retriever = (catalog) => Promise.resolve(catalog.products);

/** Every wine, the acceptable ones first. */
const acceptableFirst: Retriever = (catalog, query) =>
  Promise.resolve(
    [...catalog.products].sort(
      (a, b) =>
        Number(query.acceptable.includes(b.product.sku)) -
        Number(query.acceptable.includes(a.product.sku)),
    ),
  );

describe('a deterministic run against the fake provider, as CI runs it', () => {
  it('scores the whole dataset identically twice', async () => {
    const first = await runEval({
      dataset,
      provider: fakeLlmProvider(),
      retriever: lexicalRetriever,
    });
    const second = await runEval({
      dataset,
      provider: fakeLlmProvider(),
      retriever: lexicalRetriever,
    });

    expect(first.results).toHaveLength(60);
    expect(second.results).toEqual(first.results);
    expect(second.summary).toEqual(first.summary);
  });

  it('hands the model at most eight candidates, and scores a run a table can show', async () => {
    const provider = fakeLlmProvider();
    const { summary } = await runEval({ dataset, provider, retriever: lexicalRetriever });

    expect(provider.requests).toHaveLength(60);
    expect(Math.max(...provider.requests.map((request) => request.candidates.length))).toBe(
      CANDIDATE_LIMIT,
    );
    expect(summary.schemaFailureRate).toBe(0);
    expect(summary.outsideCandidates).toBe(0);
    expect(summary.recallAt8).toBeGreaterThan(0);
    expect(summary.honestyRate).toBeGreaterThan(0);
    expect(formatReport([{ provider: summary.provider, runs: [summary, summary] }])).toContain(
      '| fake |',
    );
  });
});

describe('scoring what comes back', () => {
  it('counts every schema failure against the provider, and the table disqualifies it', async () => {
    const { summary } = await runEval({
      dataset: only('q01', 'q02'),
      provider: scripted(() => [{ type: 'error', code: 'schema_invalid' }]),
      retriever: everything,
    });

    expect(summary.schemaFailureRate).toBe(1);
    expect(formatReport([{ provider: 'scripted', runs: [summary, summary] }])).toContain(
      'disqualified',
    );
  });

  it('scores a recommendation by the SKU behind its candidate, and an id it was never given as outside', async () => {
    const { results, summary } = await runEval({
      dataset: only('q01'),
      provider: scripted((request) => [
        { type: 'text', delta: 'Consiglio questi.' },
        {
          type: 'recommendations',
          items: [
            { productId: request.candidates[0]?.id ?? '', reason: 'Tannino.', confidence: 0.9 },
            { productId: randomUUID(), reason: 'Inventato.', confidence: 0.9 },
          ],
        },
      ]),
      retriever: acceptableFirst,
    });

    const [first] = results;
    expect(first?.recommended).toEqual([first?.retrieved[0], null]);
    expect([first?.hits, first?.firstHitRank, first?.outcome, first?.reply]).toEqual([
      1,
      1,
      'answered',
      'Consiglio questi.',
    ]);
    expect([summary.pairingHitRate, summary.outsideCandidates]).toEqual([1, 1]);
  });

  it('calls a stream that ends with text alone text_only', async () => {
    const { results } = await runEval({
      dataset: only('q01'),
      provider: scripted(() => [{ type: 'text', delta: 'Non saprei.' }]),
      retriever: everything,
    });

    expect(results[0]?.outcome).toBe('text_only');
  });

  it('caps the candidates at the limit it is given', async () => {
    const provider = fakeLlmProvider();

    await runEval({ dataset: only('q01'), provider, retriever: everything, limit: 3 });

    expect(provider.requests[0]?.candidates).toHaveLength(3);
  });

  it('asks in the query language, with no history', async () => {
    const english = dataset.queries.find((query) => query.locale === 'en');
    if (english === undefined) throw new Error('expected an English query');
    const provider = fakeLlmProvider();

    await runEval({ dataset: only(english.id), provider, retriever: everything });

    expect(provider.requests[0]).toMatchObject({ query: english.query, locale: 'en', history: [] });
  });

  it('asks the judge only about answers, showing it exactly what the model was given', async () => {
    const [answered] = only('q01').queries;
    const judge = vi.fn<Judge>(() => Promise.resolve({ score: 0.8, rejected: false }));
    const provider = scripted((request) =>
      request.query === answered?.query
        ? [
            {
              type: 'recommendations',
              items: [
                { productId: request.candidates[0]?.id ?? '', reason: 'Tannino.', confidence: 0.5 },
              ],
            },
          ]
        : [{ type: 'error', code: 'refusal' }],
    );

    const { summary } = await runEval({
      dataset: only('q01', 'q02'),
      provider,
      retriever: everything,
      judge,
    });

    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]?.[0].candidates).toEqual(provider.requests[0]?.candidates);
    expect([summary.judgeScore, summary.refusalRate]).toEqual([0.8, 0.5]);
  });

  it('hands its abort signal to the provider', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const inner = fakeLlmProvider();
    const provider: LlmProvider = {
      id: 'watching',
      streamPairing: (request, signal) => {
        seen.push(signal);
        return inner.streamPairing(request, signal);
      },
    };

    await runEval({
      dataset: only('q01'),
      provider,
      retriever: everything,
      signal: controller.signal,
    });

    expect(seen).toEqual([controller.signal]);
  });

  it('refuses a query naming a catalogue that was not seeded', async () => {
    await expect(
      runEval({
        dataset: { catalogs: [], queries: only('q01').queries },
        provider: fakeLlmProvider(),
        retriever: everything,
      }),
    ).rejects.toThrow(/was not seeded/);
  });
});
