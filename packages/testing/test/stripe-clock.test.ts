import { describe, expect, it } from 'vitest';

import {
  advanceTestClock,
  createClockCustomer,
  createTestClock,
  days,
  StripeClockError,
  stripeTestCall,
  type StripeCall,
} from '../src/stripe-clock.js';

/**
 * Stripe Test Clocks (P5-14), against a stand-in: the requests sent, the wait
 * until a clock settles, and the refusal of anything but a test-mode key. The
 * key is built at runtime, never written down (P0-56).
 */

const testKey = (mode = 'test') => ['sk', mode, 'abcdefghijklmnopqrstuvwx'].join('_');

describe('the client', () => {
  it('refuses a live key before sending anything, and never echoes it', () => {
    const live = testKey('live');

    expect(() => stripeTestCall({ secretKey: live, apiVersion: 'v' })).toThrow(StripeClockError);
    expect(() => stripeTestCall({ secretKey: live, apiVersion: 'v' })).not.toThrow(live);
  });

  it('sends the pinned version, the key and a form body', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const call = stripeTestCall({
      secretKey: testKey(),
      apiVersion: '2026-08-26.dahlia',
      base: 'http://stripe.test',
      fetch: (url, init) => {
        const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

        sent.push({ url: href, init: init ?? {} });
        return Promise.resolve(new Response(JSON.stringify({ id: 'clock_1' }), { status: 200 }));
      },
    });

    await call('POST', '/v1/test_helpers/test_clocks', { frozen_time: 1, name: 'x' });

    expect(sent[0]?.url).toBe('http://stripe.test/v1/test_helpers/test_clocks');
    expect(sent[0]?.init.body).toBe('frozen_time=1&name=x');
    expect(sent[0]?.init.headers).toMatchObject({
      authorization: `Bearer ${testKey()}`,
      'stripe-version': '2026-08-26.dahlia',
    });
  });

  it('reports a refusal by its type and code only', async () => {
    const call = stripeTestCall({
      secretKey: testKey(),
      apiVersion: 'v',
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { type: 'invalid_request_error', code: 'x', message: 'mail a@b.example' },
            }),
            { status: 400 },
          ),
        ),
    });

    await expect(call('GET', '/v1/x')).rejects.toThrow(
      'Stripe refused GET /v1/x: invalid_request_error (x).',
    );
  });
});

describe('a clock', () => {
  /** A stand-in that answers each call from a script, in order. */
  const scripted = (...answers: unknown[]) => {
    const calls: string[] = [];
    const call: StripeCall = (method, path, params) => {
      calls.push(`${method} ${path} ${JSON.stringify(params ?? {})}`);
      return Promise.resolve(answers.shift());
    };

    return { call, calls };
  };

  it('is created frozen at the time asked for, and carries a customer', async () => {
    const { call, calls } = scripted(
      { id: 'clock_1', frozen_time: 100, status: 'ready' },
      { id: 'cus_1' },
    );

    expect(await createTestClock(call, 100)).toEqual({
      id: 'clock_1',
      frozenTime: 100,
      status: 'ready',
    });
    expect(await createClockCustomer(call, 'clock_1', 'a@b.example')).toBe('cus_1');
    expect(calls[1]).toBe('POST /v1/customers {"test_clock":"clock_1","email":"a@b.example"}');
  });

  it('advances, and waits until Stripe has run everything due', async () => {
    const { call, calls } = scripted(
      {},
      { id: 'clock_1', frozen_time: 200, status: 'advancing' },
      { id: 'clock_1', frozen_time: 200, status: 'ready' },
    );

    expect(
      await advanceTestClock(call, 'clock_1', 200, { pause: () => Promise.resolve() }),
    ).toEqual({
      id: 'clock_1',
      frozenTime: 200,
      status: 'ready',
    });
    expect(calls).toHaveLength(3);
  });

  it('says so when a clock fails, or never settles', async () => {
    await expect(
      advanceTestClock(
        scripted({}, { id: 'c', frozen_time: 1, status: 'internal_failure' }).call,
        'c',
        1,
        {
          pause: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow(/failed while advancing/u);

    await expect(
      advanceTestClock(
        scripted({}, { id: 'c', frozen_time: 1, status: 'advancing' }).call,
        'c',
        1,
        {
          attempts: 1,
          pause: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow(/still advancing/u);
  });

  it('refuses an answer that is not a clock', async () => {
    await expect(createTestClock(scripted({ id: 1 }).call, 1)).rejects.toThrow(/not a test clock/u);
  });

  it('counts days in Stripe’s seconds', () => {
    expect(days(14)).toBe(1_209_600);
  });
});
