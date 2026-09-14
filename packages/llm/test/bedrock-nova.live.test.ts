import process from 'node:process';

import type { PairingRequest } from '@catalogorosso/core';
import { describe, expect, it } from 'vitest';

import { bedrockNovaProvider } from '../src/bedrock-nova.js';
import type { PairingUsage } from '../src/usage.js';

/**
 * Nova against real Bedrock (P1-42). **Skipped unless `LIVE_BEDROCK=1`.**
 *
 * It costs money and needs AWS credentials with access to the model, so it is
 * not part of CI; it runs with the P1-47 bake-off, where the credentials and
 * the spend are already agreed. What it proves is the one thing a fake cannot:
 * that the cache point sits where Bedrock caches, so a second request with the
 * same prefix reads it rather than paying for it again. A cache that silently
 * never hits is a large cost regression that every functional test would pass.
 *
 * Environment: `BEDROCK_NOVA_MODEL_ID` (the model or inference-profile id),
 * plus the usual AWS region and credentials.
 */

const live = process.env.LIVE_BEDROCK === '1';

const request = (query: string): PairingRequest => ({
  query,
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
});

describe.skipIf(!live)('Nova on Bedrock, live', () => {
  it('reads the cached prefix on the second request', async () => {
    const usages: PairingUsage[] = [];
    const provider = bedrockNovaProvider({
      modelId: process.env.BEDROCK_NOVA_MODEL_ID ?? '',
      onUsage: (usage) => usages.push(usage),
    });

    for (const query of ['un rosso per il brasato', 'un vino per la bistecca']) {
      for await (const chunk of provider.streamPairing(
        request(query),
        new AbortController().signal,
      )) {
        expect(chunk.type).not.toBe('error');
      }
    }

    expect(usages).toHaveLength(2);
    expect(usages[1]?.cacheReadInputTokens).toBeGreaterThan(0);
  }, 60_000);
});
