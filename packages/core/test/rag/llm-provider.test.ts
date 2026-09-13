import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PAIRING_ERROR_CODES,
  type LlmProvider,
  type PairingChunk,
  type PairingRequest,
  type Recommendation,
} from '../../src/rag/llm-provider.js';

/**
 * The generation port (P1-41).
 *
 * The port has almost no runtime, so most of what it promises is about its
 * shape: that nothing vendor-specific is in it, that a failure is a chunk, and
 * that a caller cannot start a stream without a way to stop it. The type
 * assertions run under `tsc`, which checks the test files too.
 */

const SOURCE = readFileSync(join(import.meta.dirname, '../../src/rag/llm-provider.ts'), 'utf8');

const REQUEST: PairingRequest = {
  query: 'un rosso per il brasato',
  locale: 'it',
  candidates: [{ id: 'p-1', name: 'Barolo Bussia', wineType: 'red' }],
  history: [],
};

describe('the provider port', () => {
  it('imports only core’s own types, so no vendor shape can arrive through it', () => {
    const specifiers = [...SOURCE.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);

    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.every((specifier) => specifier?.startsWith('./'))).toBe(true);
    expect(SOURCE).not.toMatch(/^import (?!type )/m);
  });

  it('makes a schema failure an outcome to handle, not an exception to catch', () => {
    expect(PAIRING_ERROR_CODES).toEqual(['schema_invalid', 'refusal', 'provider_error']);
    expectTypeOf<Extract<PairingChunk, { type: 'error' }>['code']>().toEqualTypeOf<
      'schema_invalid' | 'refusal' | 'provider_error'
    >();
  });

  it('cannot be called without an abort signal', () => {
    expectTypeOf<Parameters<LlmProvider['streamPairing']>>().toEqualTypeOf<
      [PairingRequest, AbortSignal]
    >();
  });

  it('carries recommendations as an id, a reason and a confidence, and nothing else', () => {
    expectTypeOf<keyof Recommendation>().toEqualTypeOf<'productId' | 'reason' | 'confidence'>();
  });

  it('keeps system instructions out of the history a visitor can influence', () => {
    expectTypeOf<PairingRequest['history'][number]['role']>().toEqualTypeOf<'user' | 'assistant'>();
  });

  it('can be implemented with no vendor library at all, and consumed as a stream', async () => {
    const provider: LlmProvider = {
      id: 'inline',
      streamPairing: (request) =>
        (async function* () {
          await Promise.resolve();
          yield { type: 'text', delta: `Per «${request.query}»: ` } as const;
          yield {
            type: 'recommendations',
            items: [
              { productId: request.candidates[0]?.id ?? '', reason: 'Tannini', confidence: 0.8 },
            ],
          } as const;
        })(),
    };

    const chunks: PairingChunk[] = [];
    for await (const chunk of provider.streamPairing(REQUEST, new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.type)).toEqual(['text', 'recommendations']);
  });
});
