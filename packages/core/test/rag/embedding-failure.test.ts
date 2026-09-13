import { describe, expect, it } from 'vitest';

import {
  classifyEmbeddingFailure,
  EMBEDDING_FAILURE_REASONS,
  EmbeddingProviderError,
  embeddingFailureOf,
  OPERATOR_PROVIDER_ERRORS,
  REJECTED_INPUT_PROVIDER_ERRORS,
  RETRYABLE_PROVIDER_ERRORS,
  UNKNOWN_FAILURE_DELIVERIES,
} from '../../src/rag/embedding-failure.js';

/**
 * Sorting embedding failures (P1-50).
 *
 * What each class does to a message is asserted in the worker's tests. What is
 * here is the sorting itself — and the one rule that matters most: nothing but
 * the provider refusing a call can ever be permanent.
 */

const fromProvider = (name: unknown): EmbeddingProviderError =>
  new EmbeddingProviderError(Object.assign(new Error('refused'), { name }));

describe('classifyEmbeddingFailure', () => {
  it.each([...RETRYABLE_PROVIDER_ERRORS, ...OPERATOR_PROVIDER_ERRORS])(
    'retries %s, and blames the service rather than the seller',
    (name) => {
      expect(classifyEmbeddingFailure(fromProvider(name), 3)).toEqual({
        kind: 'transient',
        reason: 'service-unavailable',
        retry: true,
        providerError: name,
      });
    },
  );

  it('fails a refused input at once, whatever the delivery', () => {
    for (const deliveries of [1, 3]) {
      expect(classifyEmbeddingFailure(fromProvider('ValidationException'), deliveries)).toEqual({
        kind: 'permanent',
        reason: 'input-rejected',
        retry: false,
        providerError: 'ValidationException',
      });
    }
  });

  it('gives an unrecognised provider error exactly one more delivery', () => {
    expect(UNKNOWN_FAILURE_DELIVERIES).toBe(2);

    expect(classifyEmbeddingFailure(fromProvider('ModelErrorException'), 1)).toMatchObject({
      kind: 'unknown',
      reason: 'unknown',
      retry: true,
    });
    expect(classifyEmbeddingFailure(fromProvider('ModelErrorException'), 2).retry).toBe(false);
    expect(classifyEmbeddingFailure(fromProvider('ModelErrorException'), 3).retry).toBe(false);
  });

  it('treats a provider error with no usable name as unknown', () => {
    expect(classifyEmbeddingFailure(fromProvider(42), 1)).toMatchObject({
      kind: 'unknown',
      providerError: undefined,
    });
  });

  it('never makes a failure permanent unless the provider call raised it', () => {
    // A database error that happens to share a provider's name, on a late delivery.
    const database = Object.assign(new Error('connection lost'), { name: 'ValidationException' });

    expect(classifyEmbeddingFailure(database, 5)).toEqual({
      kind: 'transient',
      reason: 'service-unavailable',
      retry: true,
      providerError: undefined,
    });
    expect(classifyEmbeddingFailure('not even an error', 5).retry).toBe(true);
  });

  it('keeps each provider error in exactly one class', () => {
    const names = [
      ...RETRYABLE_PROVIDER_ERRORS,
      ...OPERATOR_PROVIDER_ERRORS,
      ...REJECTED_INPUT_PROVIDER_ERRORS,
    ];

    expect(new Set(names).size).toBe(names.length);
  });

  it('names its wrapper, so a check across module copies still recognises it', () => {
    const wrapped = fromProvider('ThrottlingException');

    expect(wrapped.name).toBe('EmbeddingProviderError');
    expect((wrapped.cause as Error).name).toBe('ThrottlingException');
  });
});

describe('embeddingFailureOf', () => {
  it('pins the reasons the API publishes', () => {
    expect(EMBEDDING_FAILURE_REASONS).toEqual(['input-rejected', 'service-unavailable', 'unknown']);
  });

  it.each(EMBEDDING_FAILURE_REASONS)('publishes %s for a failed wine that stored it', (reason) => {
    expect(embeddingFailureOf({ state: 'FAILED', error: reason })).toBe(reason);
  });

  it('reads a provider name stored before P1-50, or nothing at all, as unknown', () => {
    expect(embeddingFailureOf({ state: 'FAILED', error: 'ThrottlingException' })).toBe('unknown');
    expect(embeddingFailureOf({ state: 'FAILED', error: null })).toBe('unknown');
  });

  it('says nothing for a wine that is not failed, whatever the column holds', () => {
    for (const state of ['PENDING', 'INDEXED', 'STALE']) {
      expect(embeddingFailureOf({ state, error: 'input-rejected' })).toBeNull();
    }
  });
});
