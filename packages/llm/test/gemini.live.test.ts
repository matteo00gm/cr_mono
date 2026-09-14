import process from 'node:process';

import type { PairingChunk, PairingRequest } from '@catalogorosso/core';
import { describe, expect, it } from 'vitest';

import { geminiProvider } from '../src/gemini.js';

/**
 * Gemini against the real API (P1-43). **Skipped unless `LIVE_GEMINI=1`.**
 *
 * It costs money and needs a key, so it is not part of CI; it runs with the
 * P1-47 bake-off. What it proves is the one thing a fake cannot: that Gemini
 * accepts the response schema projected from P2-24's, and that what comes back
 * passes our own validation. A projection Gemini rejects fails every request,
 * and every functional test would still pass.
 *
 * Environment: `GEMINI_MODEL` and `GEMINI_API_KEY`, set in your own shell.
 */

const live = process.env.LIVE_GEMINI === '1';

const PRODUCT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const request: PairingRequest = {
  query: 'un rosso per il brasato',
  locale: 'it',
  candidates: [
    {
      id: PRODUCT,
      name: 'Barolo Bussia',
      wineType: 'rosso',
      grapeVarieties: ['Nebbiolo'],
      tastingNotes: 'Rosa appassita, catrame, tannini fitti.',
      priceCents: 4500,
    },
  ],
  history: [],
};

describe.skipIf(!live)('Gemini, live', () => {
  it('accepts the projected schema and returns a pairing that passes validation', async () => {
    const provider = geminiProvider({
      model: process.env.GEMINI_MODEL ?? '',
      apiKey: process.env.GEMINI_API_KEY ?? '',
    });

    const chunks: PairingChunk[] = [];
    for await (const chunk of provider.streamPairing(request, new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    expect(chunks.at(-1)?.type).toBe('recommendations');
  }, 60_000);
});
