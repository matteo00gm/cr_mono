import process from 'node:process';

import type { PairingChunk, PairingRequest } from '@catalogorosso/core';
import { describe, expect, it } from 'vitest';

import { anthropicProvider } from '../src/anthropic.js';

/**
 * Claude against the real API (P1-44). **Skipped unless `LIVE_ANTHROPIC=1`.**
 *
 * It costs money and needs a key, so it is not part of CI; it runs with the
 * P1-47 bake-off. What it proves is what a fake cannot: that structured outputs
 * accept the schema as the SDK projects it, and that the answer passes our own
 * validation.
 *
 * Environment: `ANTHROPIC_MODEL` and `ANTHROPIC_API_KEY`, set in your own shell.
 */

const live = process.env.LIVE_ANTHROPIC === '1';

const request: PairingRequest = {
  query: 'un rosso per il brasato',
  locale: 'it',
  candidates: [
    {
      id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      name: 'Barolo Bussia',
      wineType: 'rosso',
      grapeVarieties: ['Nebbiolo'],
      tastingNotes: 'Rosa appassita, catrame, tannini fitti.',
      priceCents: 4500,
    },
  ],
  history: [],
};

describe.skipIf(!live)('Claude, live', () => {
  it('accepts the projected schema and returns a pairing that passes validation', async () => {
    const provider = anthropicProvider({
      model: process.env.ANTHROPIC_MODEL ?? '',
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    });

    const chunks: PairingChunk[] = [];
    for await (const chunk of provider.streamPairing(request, new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    expect(chunks.at(-1)?.type).toBe('recommendations');
  }, 60_000);
});
