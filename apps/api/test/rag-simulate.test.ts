import { ragSimulationResponse } from '@catalogorosso/api-client';
import { PROMPT_MARKER, pairingSystemPrompt } from '@catalogorosso/core';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import {
  RagPortNotConfiguredError,
  unconfiguredRag,
  type RagPort,
  type RetrievalSimulation,
} from '../src/rag.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * `POST /v1/dashboard/rag/simulate` — the surface (P2-37).
 *
 * What the pipeline *does* is asserted against real Postgres in
 * `rag-simulate.integration.test.ts`, because a fake ranking proves nothing
 * about a ranking. What is asserted here is the surface around it: which body
 * is accepted, that a tenant comes from the membership rather than the body
 * (P0-48), and the one thing that would be a security bug rather than a
 * defect — that the instructions never leave the building.
 *
 * **The capability guard is not asserted by a refusal here**, for the reason
 * `products-reindex.test.ts` gives: `catalog:read` is held by every role, so a
 * request cannot demonstrate the guard by being refused. `rbac-matrix.test.ts`
 * enumerates the router and fails on a route that is undeclared or declared
 * with the wrong capability, which is the test that can fail.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const PATH = '/v1/dashboard/rag/simulate';

const EMPTY: RetrievalSimulation = {
  candidates: [],
  preCapCount: 0,
  zeroResultKind: 'no_matches',
  timings: { embedMs: 1, searchMs: 2 },
  systemPromptHash: 'deadbeefdeadbeef',
};

const app = (rag: RagPort) =>
  createApp({
    auth: signedIn(),
    readMemberships: oneMembership(TENANT, 'EDITOR'),
    rag,
  });

const post = (rag: RagPort, body: unknown) =>
  app(rag).request(PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const recording = (result: RetrievalSimulation = EMPTY) => {
  const simulate = vi.fn(() => Promise.resolve(result));

  return { simulate, port: { simulate } satisfies RagPort };
};

describe('the body it accepts', () => {
  it('runs a question', async () => {
    const { simulate, port } = recording();

    const response = await post(port, { query: 'qualcosa per una bistecca' });

    expect(response.status).toBe(200);
    expect(simulate).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'qualcosa per una bistecca' }),
    );
  });

  it('takes the tenant from the membership, never from the body (P0-48)', async () => {
    const { simulate, port } = recording();

    await post(port, {
      query: 'barolo',
      tenantId: '22222222-2222-2222-2222-222222222222',
    });

    // Strict, so the field does not merely get ignored: the request is refused.
    expect(simulate).not.toHaveBeenCalled();
  });

  it('refuses an unknown field rather than silently running the default', async () => {
    /*
     * `.strict()` here and not on the product bodies, and the difference is who
     * is sending. Every field on this one is a knob on an experiment; a
     * misspelt `maxPrice` that parsed cleanly would report on a run nobody
     * asked for, and the report would look exactly like the one they wanted.
     */
    const { simulate, port } = recording();

    const response = await post(port, { query: 'barolo', maxPrice: 3000 });

    expect(response.status).toBe(422);
    expect(simulate).not.toHaveBeenCalled();
  });

  it('refuses an empty question', async () => {
    expect((await post(recording().port, { query: '   ' })).status).toBe(422);
  });

  it('refuses a question longer than the model reads', async () => {
    // 500 characters is what P2-17 embeds; accepting more would promise a
    // search over text that was silently truncated before the search.
    expect((await post(recording().port, { query: 'a'.repeat(501) })).status).toBe(422);
  });

  it('passes a price ceiling and a cap through as given', async () => {
    const { simulate, port } = recording();

    await post(port, { query: 'barolo', maxPriceCents: 3000, cap: 3 });

    expect(simulate).toHaveBeenCalledWith(expect.objectContaining({ maxPriceCents: 3000, cap: 3 }));
  });

  it('refuses a cap larger than the number of candidates retrieval offers', async () => {
    expect((await post(recording().port, { query: 'barolo', cap: 41 })).status).toBe(422);
  });
});

describe('what comes back', () => {
  it('matches the published contract', async () => {
    const response = await post(
      recording({
        ...EMPTY,
        candidates: [
          {
            productId: '3f1c0b7e-4a30-4c1a-9f2e-1b7e4a304c1a',
            name: 'Barolo Monfortino',
            vectorRank: 2,
            vectorScore: 0.81,
            lexicalRank: 1,
            rrfScore: 0.0325,
            completeness: { score: 78, missing: ['vintage'], topSuggestion: 'vintage' },
            stockStatus: 'IN_STOCK',
            priceCents: 18_500,
            included: true,
            excludedBy: null,
          },
        ],
        preCapCount: 23,
        zeroResultKind: null,
      }).port,
      { query: 'barolo' },
    );

    expect(ragSimulationResponse.safeParse(await response.json()).success).toBe(true);
  });

  it('never carries the system prompt, only a hash of it', async () => {
    /*
     * **The one assertion here that is a security boundary rather than a
     * contract.** Returning the assembled prompt would publish our instructions
     * to every tenant (§3.7) — and it is the obvious thing for a future "make
     * the sandbox more useful" change to add, which is why it is asserted
     * against the real prompt rather than against a marker string.
     */
    const response = await post(recording().port, { query: 'barolo' });
    const body = await response.text();

    expect(body).not.toContain(PROMPT_MARKER);
    expect(body).not.toContain(pairingSystemPrompt().slice(0, 40));
    expect(JSON.parse(body)).toHaveProperty('systemPromptHash');
  });
});

describe('an unwired port', () => {
  it('throws rather than reporting that retrieval found nothing', () => {
    /*
     * An empty candidate list is a real answer this endpoint can give, and it
     * is the answer a merchant acts on by rewriting their catalogue. A port
     * wired to nothing must not be able to produce it.
     */
    expect(() => unconfiguredRag.simulate({ tenantId: TENANT, query: 'barolo' })).toThrow(
      RagPortNotConfiguredError,
    );
  });
});
