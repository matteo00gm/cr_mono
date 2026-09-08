import { describe, expect, it } from 'vitest';

import {
  assertBatchAligned,
  assertProviderFitsColumn,
  EmbeddingDimensionMismatchError,
  type EmbeddingProvider,
} from '../../src/rag/embedding-provider.js';

/**
 * The embedding seam (P1-35).
 *
 * Both assertions here exist because their failure modes are *quiet*. A
 * dimension mismatch surfaces as a DLQ full of products that look like
 * embedding failures; a short batch surfaces as a catalogue where each wine is
 * described by its neighbour, with nothing throwing at all.
 */

const fake = (overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider => ({
  model: 'fake-embed-v1',
  dim: 1024,
  embed: (texts) => Promise.resolve(texts.map(() => Array.from({ length: 1024 }, () => 0))),
  ...overrides,
});

describe('the interface', () => {
  it('is satisfiable by something with no cloud in it', async () => {
    /*
     * The point of the port: a test of the worker needs a provider, and a
     * provider that needed Bedrock would make every one of those tests need
     * credentials and a network.
     */
    const vectors = await fake().embed(['one', 'two']);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(1024);
  });
});

describe('assertProviderFitsColumn', () => {
  it('accepts a provider whose vectors fit', () => {
    expect(assertProviderFitsColumn(fake(), 1024).model).toBe('fake-embed-v1');
  });

  it('refuses one whose vectors do not, at construction', () => {
    /*
     * **A boot failure, and the placement is the point.** The alternative is a
     * worker that starts healthy, drains the queue and fails every insert with
     * a Postgres type error — which reads as a wave of embedding failures
     * rather than as one configuration mistake.
     */
    expect(() => assertProviderFitsColumn(fake({ dim: 1536 }), 1024)).toThrow(
      EmbeddingDimensionMismatchError,
    );
  });

  it('says both numbers, because the useful answer is which one is wrong', () => {
    let message = '';
    try {
      assertProviderFitsColumn(fake({ dim: 1536 }), 1024);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('1536');
    expect(message).toContain('1024');
    expect(message).toContain('fake-embed-v1');
  });
});

describe('assertBatchAligned', () => {
  it('accepts a response of the right length', () => {
    expect(() => {
      assertBatchAligned('m', ['a', 'b'], [[1], [2]]);
    }).not.toThrow();
  });

  it('refuses a short batch rather than trimming it', () => {
    /*
     * **The failure this prevents does not throw on its own.** A response one
     * element short pairs every vector after the gap with the wrong product, so
     * each wine ends up described by its neighbour — retrieval works, the
     * answers are quietly wrong, and nothing points at the cause.
     */
    expect(() => {
      assertBatchAligned('m', ['a', 'b', 'c'], [[1], [2]]);
    }).toThrow(/wrong products/);
  });

  it('refuses a long one too', () => {
    expect(() => {
      assertBatchAligned('m', ['a'], [[1], [2]]);
    }).toThrow();
  });
});
