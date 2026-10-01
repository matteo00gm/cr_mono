/**
 * Stripe Test Clocks, for the states only time can reach (P5-14).
 *
 * A clock freezes Stripe's time for the customers attached to it, and
 * advancing it runs everything due in between — renewals, retries, the
 * `invoice.payment_failed` a recurring charge on `4000 0000 0000 0341`
 * produces. It is the only honest way to test a renewal that fails: the
 * alternative is waiting a month, or faking the transition and testing nothing.
 *
 * **Test mode only, refused otherwise.** A clock exists only in test mode, and
 * a live key handed to a helper whose whole job is making payments fail is a
 * mistake worth stopping before it is sent anywhere. The key is never echoed.
 *
 * Needs a Stripe test account, which no commit supplies: the operator runs it
 * with `STRIPE_SECRET_KEY` set to a `sk_test_` key (`docs/runbooks/billing-states.md`).
 * The suite here drives it against a stand-in.
 */

export interface TestClock {
  readonly id: string;
  readonly frozenTime: number;
  readonly status: string;
}

export type StripeCall = (
  method: 'GET' | 'POST',
  path: string,
  params?: Readonly<Record<string, string | number>>,
) => Promise<unknown>;

export class StripeClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeClockError';
  }
}

export interface StripeCallOptions {
  readonly secretKey: string;
  /** The pinned version, passed in so this package holds no copy of it (P5-01). */
  readonly apiVersion: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly base?: string | undefined;
}

/** A two-verb Stripe client for test-mode keys only. */
export const stripeTestCall = ({
  secretKey,
  apiVersion,
  fetch = globalThis.fetch,
  base = 'https://api.stripe.com',
}: StripeCallOptions): StripeCall => {
  if (!/^(?:sk|rk)_test_/u.test(secretKey)) {
    throw new StripeClockError(
      'Test clocks need a test-mode key (sk_test_ or rk_test_). Its value is not printed.',
    );
  }

  return async (method, path, params = {}) => {
    const body = new URLSearchParams(
      Object.entries(params).map(([name, value]) => [name, String(value)]),
    ).toString();
    const response = await fetch(
      method === 'GET' && body !== '' ? `${base}${path}?${body}` : `${base}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${secretKey}`,
          'stripe-version': apiVersion,
          ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(method === 'POST' ? { body } : {}),
      },
    );
    const json = (await response.json()) as { error?: { type?: string; code?: string } };

    if (!response.ok) {
      /* Type and code only: Stripe's prose can quote a customer's email (P5-02). */
      throw new StripeClockError(
        `Stripe refused ${method} ${path}: ${json.error?.type ?? 'error'}` +
          `${json.error?.code === undefined ? '' : ` (${json.error.code})`}.`,
      );
    }

    return json;
  };
};

const asClock = (json: unknown): TestClock => {
  const clock = json as { id?: unknown; frozen_time?: unknown; status?: unknown };

  if (
    typeof clock.id !== 'string' ||
    typeof clock.frozen_time !== 'number' ||
    typeof clock.status !== 'string'
  ) {
    throw new StripeClockError('Stripe answered with something that is not a test clock.');
  }

  return { id: clock.id, frozenTime: clock.frozen_time, status: clock.status };
};

/** A clock frozen at `frozenTime` (Stripe's seconds). */
export const createTestClock = async (
  call: StripeCall,
  frozenTime: number,
  name = 'catalogorosso lifecycle',
): Promise<TestClock> =>
  asClock(await call('POST', '/v1/test_helpers/test_clocks', { frozen_time: frozenTime, name }));

/** A customer living on the clock's time; subscribe it through Checkout as any other. */
export const createClockCustomer = async (
  call: StripeCall,
  clockId: string,
  email: string,
): Promise<string> => {
  const customer = (await call('POST', '/v1/customers', { test_clock: clockId, email })) as {
    id?: unknown;
  };

  if (typeof customer.id !== 'string') {
    throw new StripeClockError('Stripe answered with something that is not a customer.');
  }

  return customer.id;
};

/**
 * Moves the clock to `frozenTime` and waits until Stripe has run everything
 * due on the way — renewals, retries, the webhooks they send — so the next
 * assertion reads a settled world rather than one still advancing.
 */
export const advanceTestClock = async (
  call: StripeCall,
  clockId: string,
  frozenTime: number,
  { attempts = 60, pause = (ms: number) => new Promise((done) => setTimeout(done, ms)) } = {},
): Promise<TestClock> => {
  await call('POST', `/v1/test_helpers/test_clocks/${encodeURIComponent(clockId)}/advance`, {
    frozen_time: frozenTime,
  });

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const clock = asClock(
      await call('GET', `/v1/test_helpers/test_clocks/${encodeURIComponent(clockId)}`),
    );

    if (clock.status === 'ready') return clock;

    if (clock.status === 'internal_failure') {
      throw new StripeClockError(`Test clock ${clockId} failed while advancing.`);
    }

    await pause(1_000);
  }

  throw new StripeClockError(
    `Test clock ${clockId} was still advancing after ${String(attempts)} checks.`,
  );
};

/** Days, in Stripe's seconds, for advancing a clock across a trial or a renewal. */
export const days = (count: number): number => count * 86_400;
