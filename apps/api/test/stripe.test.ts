import { STRIPE_API_VERSION } from '@catalogorosso/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createStripeClient, StripeRequestError } from '../src/stripe.js';

/**
 * The API's Stripe client (P5-02), against a `fetch` that records what it was
 * asked and answers what the case needs.
 *
 * The key is built at runtime (P0-56).
 */

const KEY = ['sk', 'test', 'x'.repeat(24)].join('_');

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

const answering = (status: number, body: unknown) => {
  const sent: Sent[] = [];
  const fetch_ = ((url: string, init: RequestInit) => {
    sent.push({ url, init });

    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
  }) as unknown as typeof fetch;

  return {
    sent,
    client: createStripeClient({ secretKey: KEY, fetch: fetch_, base: 'https://stripe.test' }),
  };
};

const headersOf = (sent: Sent | undefined) => (sent?.init.headers ?? {}) as Record<string, string>;

const idOnly = z.object({ id: z.string() });

describe('a GET', () => {
  it('sends its parameters in the query, encoded as Stripe reads them, and no body', async () => {
    const { sent, client } = answering(200, { id: 'price_1' });

    await client.get('/v1/prices', { lookup_keys: ['cantina_monthly_eur'], active: true }, idOnly);

    expect(sent[0]?.url).toBe(
      'https://stripe.test/v1/prices?lookup_keys%5B0%5D=cantina_monthly_eur&active=true',
    );
    expect(sent[0]?.init.method).toBe('GET');
    expect(sent[0]?.init.body).toBeUndefined();
  });

  it('asks with no query string when there is nothing to ask', async () => {
    const { sent, client } = answering(200, { id: 'sub_1' });

    await client.get('/v1/subscriptions/sub_1', {}, idOnly);

    expect(sent[0]?.url).toBe('https://stripe.test/v1/subscriptions/sub_1');
  });
});

describe('a POST', () => {
  it('sends a form body with its content type', async () => {
    const { sent, client } = answering(200, { id: 'cs_1' });

    await client.post(
      '/v1/checkout/sessions',
      { mode: 'subscription', metadata: { tenant_id: 't' } },
      idOnly,
    );

    expect(sent[0]?.init.method).toBe('POST');
    expect(sent[0]?.init.body).toBe('mode=subscription&metadata%5Btenant_id%5D=t');
    expect(headersOf(sent[0])['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('carries an idempotency key when given one, and none when not', async () => {
    const { sent, client } = answering(200, { id: 'x' });

    await client.post('/v1/prices', {}, idOnly, { idempotencyKey: 'once' });
    await client.post('/v1/prices', {}, idOnly);

    expect(headersOf(sent[0])['idempotency-key']).toBe('once');
    expect(headersOf(sent[1])).not.toHaveProperty('idempotency-key');
  });
});

describe('every request', () => {
  it('is authenticated, on the pinned API version, and abandoned rather than left hanging', async () => {
    const { sent, client } = answering(200, { id: 'x' });

    await client.get('/v1/prices', {}, idOnly);

    expect(headersOf(sent[0])).toMatchObject({
      authorization: `Bearer ${KEY}`,
      'stripe-version': STRIPE_API_VERSION,
    });
    expect(sent[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers with the parsed body, trimmed to the schema', async () => {
    const { client } = answering(200, { id: 'cs_1', url: 'https://checkout.stripe.com/x' });

    expect(await client.get('/v1/x', {}, idOnly)).toEqual({ id: 'cs_1' });
  });
});

describe('when Stripe refuses', () => {
  it('throws with Stripe’s type and code, and none of its words', async () => {
    /*
     * Stripe's `message` can quote a customer's email back. The log gets the
     * classification; nobody gets the prose.
     */
    const { client } = answering(402, {
      error: {
        type: 'card_error',
        code: 'card_declined',
        message: 'The card of rossi@example.com was declined.',
      },
    });

    const thrown = await client.get('/v1/x', {}, idOnly).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StripeRequestError);
    expect(thrown).toMatchObject({ status: 402, type: 'card_error', code: 'card_declined' });
    expect((thrown as Error).message).toBe('GET /v1/x: HTTP 402');
    expect(JSON.stringify(thrown)).not.toContain('rossi@example.com');
  });

  it('throws on a failure with no readable body', async () => {
    const { client } = answering(502, '<html>Bad gateway</html>');

    await expect(client.post('/v1/x', {}, idOnly)).rejects.toMatchObject({
      status: 502,
      type: undefined,
      code: undefined,
    });
  });

  it('throws on a success it cannot read, rather than handing on undefined fields', async () => {
    const { client } = answering(200, { object: 'list' });

    await expect(client.get('/v1/x', {}, idOnly)).rejects.toThrow(
      'GET /v1/x: a response we cannot read',
    );
  });

  it('throws when Stripe cannot be reached at all', async () => {
    const client = createStripeClient({
      secretKey: KEY,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });

    await expect(client.get('/v1/x', {}, idOnly)).rejects.toMatchObject({
      status: 0,
      message: 'GET /v1/x: no response',
    });
  });

  it('never puts the key in what it throws', async () => {
    const { client } = answering(401, { error: { type: 'invalid_request_error', message: KEY } });

    const thrown = await client.get('/v1/x', {}, idOnly).catch((error: unknown) => error);

    expect(`${String(thrown)} ${JSON.stringify(thrown)}`).not.toContain(KEY);
  });
});
