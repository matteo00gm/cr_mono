import type { PairingChunk, PairingRequest } from '@catalogorosso/core';
import { describe, expect, it } from 'vitest';

import { fakeLlmProvider } from '../src/fake-llm-provider.js';

/**
 * The scripted generation provider (P1-41).
 *
 * It stands in for a real model in the chat route's tests and the eval harness,
 * so what matters is that it behaves like a stream: chunks in order, requests
 * recorded, and nothing more once the caller aborts.
 */

const request = (over: Partial<PairingRequest> = {}): PairingRequest => ({
  query: 'un rosso per il brasato',
  locale: 'it',
  candidates: [{ id: 'p-1', name: 'Barolo Bussia' }],
  history: [],
  ...over,
});

const drain = async (stream: AsyncIterable<PairingChunk>): Promise<PairingChunk[]> => {
  const chunks: PairingChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

describe('fakeLlmProvider', () => {
  it('streams its script in order and records the request', async () => {
    const script: PairingChunk[] = [
      { type: 'text', delta: 'Uno' },
      { type: 'error', code: 'schema_invalid' },
    ];
    const provider = fakeLlmProvider({ id: 'scripted', respond: () => script });

    const chunks = await drain(provider.streamPairing(request(), new AbortController().signal));

    expect(provider.id).toBe('scripted');
    expect(chunks).toEqual(script);
    expect(provider.requests).toEqual([request()]);
  });

  it('stops streaming as soon as the caller aborts', async () => {
    const provider = fakeLlmProvider();
    const controller = new AbortController();
    const received: PairingChunk[] = [];

    for await (const chunk of provider.streamPairing(request(), controller.signal)) {
      received.push(chunk);
      controller.abort();
    }

    expect(received).toHaveLength(1);
    expect(provider.emitted).toHaveLength(1);
  });

  it('streams nothing for a request already aborted', async () => {
    const provider = fakeLlmProvider();
    const controller = new AbortController();
    controller.abort();

    expect(await drain(provider.streamPairing(request(), controller.signal))).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it('recommends the first candidate by default, and nothing when there are none', async () => {
    const provider = fakeLlmProvider();
    const signal = new AbortController().signal;

    const withCandidates = await drain(provider.streamPairing(request(), signal));
    expect(withCandidates.at(-1)).toMatchObject({
      type: 'recommendations',
      items: [{ productId: 'p-1' }],
    });

    const unnamed = await drain(
      provider.streamPairing(request({ candidates: [{ id: 'p-2' }] }), signal),
    );
    expect(unnamed[1]).toEqual({ type: 'text', delta: 'questo vino.' });

    const empty = await drain(provider.streamPairing(request({ candidates: [] }), signal));
    expect(empty.map((chunk) => chunk.type)).toEqual(['text']);
  });
});
