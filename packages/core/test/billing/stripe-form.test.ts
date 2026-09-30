import { describe, expect, it } from 'vitest';

import { encodeStripeForm } from '../../src/billing/stripe-form.js';

/**
 * Stripe's bracketed form encoding (P5-02).
 *
 * The cases are the shapes the API actually sends — a Checkout session's line
 * items and nested metadata — because a mis-encoded one is not refused: Stripe
 * applies a default where a parameter it expected is missing, and the session
 * looks fine and is wrong.
 */

describe('encoding for Stripe', () => {
  it('sends scalars as strings, in the order given', () => {
    expect(encodeStripeForm({ mode: 'subscription', quantity: 1, active: true })).toEqual([
      ['mode', 'subscription'],
      ['quantity', '1'],
      ['active', 'true'],
    ]);
  });

  it('leaves out an undefined value rather than sending the word', () => {
    expect(encodeStripeForm({ customer: undefined, mode: 'subscription' })).toEqual([
      ['mode', 'subscription'],
    ]);
  });

  it('nests objects as brackets, to any depth', () => {
    expect(encodeStripeForm({ subscription_data: { metadata: { tenant_id: 't1' } } })).toEqual([
      ['subscription_data[metadata][tenant_id]', 't1'],
    ]);
  });

  it('indexes an array, so each object keeps its own keys together', () => {
    expect(
      encodeStripeForm({
        line_items: [
          { price: 'price_a', quantity: 1 },
          { price: 'price_b', quantity: 2 },
        ],
      }),
    ).toEqual([
      ['line_items[0][price]', 'price_a'],
      ['line_items[0][quantity]', '1'],
      ['line_items[1][price]', 'price_b'],
      ['line_items[1][quantity]', '2'],
    ]);
  });

  it('indexes an array of scalars the same way', () => {
    expect(encodeStripeForm({ lookup_keys: ['a', 'b'] })).toEqual([
      ['lookup_keys[0]', 'a'],
      ['lookup_keys[1]', 'b'],
    ]);
  });

  it('sends nothing for an empty object or an empty array', () => {
    expect(encodeStripeForm({ metadata: {}, expand: [] })).toEqual([]);
  });
});
