import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { URLSearchParams } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Stripe setup script, run as an operator runs it (P5-01).
 *
 * Against a stand-in Stripe on this machine, because P1-47's rule covers every
 * paid or real provider call and this suite makes none. What it proves is the
 * half `stripe-catalog.test.ts` cannot: the HTTP adapter — the form encoding,
 * the headers, the pinned version, the idempotency keys — and the operator's
 * guard rails, which are exit statuses and so only mean anything from outside.
 *
 * Keys are built at runtime (P0-56): a key-shaped literal in a file is found by
 * the history scan and cannot be edited out once pushed.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'stripe-setup.mjs');

const keyFor = (mode) => ['sk', mode, randomBytes(16).toString('hex')].join('_');

/** Just enough of Stripe's v1 API for products and prices, recording every request. */
const fakeStripe = async ({ prices = [], products = [], refuseWith, refuseProducts } = {}) => {
  const state = { prices: prices.map((price) => ({ ...price })), products: new Set(products) };
  const requests = [];
  let next = 0;

  const server = createServer(async (incoming, response) => {
    const url = new URL(incoming.url, 'http://stripe.test');
    let body = '';

    for await (const chunk of incoming) body += String(chunk);

    const params = new URLSearchParams(incoming.method === 'GET' ? url.search : body);

    requests.push({
      method: incoming.method,
      path: url.pathname,
      params,
      headers: incoming.headers,
    });

    const send = (status, json) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(json));
    };

    if (refuseWith !== undefined) return send(refuseWith.status, { error: refuseWith.error });

    if (incoming.method === 'GET' && url.pathname === '/v1/prices') {
      const keys = [...params]
        .filter(([name]) => /^lookup_keys\[\d+\]$/u.test(name))
        .map(([, value]) => value);
      const data = state.prices.filter(
        (price) => price.active && price.lookup_key !== null && keys.includes(price.lookup_key),
      );

      return send(200, { object: 'list', data, has_more: false });
    }

    const product = /^\/v1\/products\/([^/]+)$/u.exec(url.pathname)?.[1];

    if (incoming.method === 'GET' && product !== undefined) {
      if (refuseProducts !== undefined)
        return send(refuseProducts.status, { error: refuseProducts.error });

      return state.products.has(product)
        ? send(200, { id: product, object: 'product' })
        : send(404, {
            error: {
              type: 'invalid_request_error',
              code: 'resource_missing',
              message: `No such product: '${product}'`,
            },
          });
    }

    if (incoming.method === 'POST' && url.pathname === '/v1/products') {
      state.products.add(params.get('id'));

      return send(200, { id: params.get('id'), object: 'product', name: params.get('name') });
    }

    if (incoming.method === 'POST' && url.pathname === '/v1/prices') {
      const lookupKey = params.get('lookup_key');

      if (params.get('transfer_lookup_key') === 'true') {
        for (const price of state.prices)
          if (price.lookup_key === lookupKey) price.lookup_key = null;
      }

      next += 1;

      const price = {
        id: `price_${String(next)}`,
        object: 'price',
        active: true,
        lookup_key: lookupKey,
        product: params.get('product'),
        unit_amount: Number(params.get('unit_amount')),
        currency: params.get('currency'),
        recurring: params.has('recurring[interval]')
          ? { interval: params.get('recurring[interval]') }
          : null,
      };

      state.prices.push(price);

      return send(200, price);
    }

    return send(404, {
      error: { type: 'invalid_request_error', message: 'Unrecognized request URL' },
    });
  });

  await new Promise((listening) => {
    server.listen(0, '127.0.0.1', listening);
  });

  const { port } = server.address();

  return {
    base: `http://127.0.0.1:${String(port)}`,
    requests,
    writes: () => requests.filter((request) => request.method === 'POST'),
    close: () =>
      new Promise((closed) => {
        server.close(closed);
      }),
  };
};

/**
 * Runs the script as a child process, with an environment built from nothing —
 * so a real `STRIPE_SECRET_KEY` in the developer's shell is never inherited.
 */
const run = (args, env) =>
  new Promise((finished) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (status) => finished({ status, stdout, stderr, output: stdout + stderr }));
  });

/** A live price exactly as `plans.ts` describes Cantina. */
const cantina = (overrides = {}) => ({
  id: 'price_live_cantina',
  object: 'price',
  active: true,
  lookup_key: 'cantina_monthly_eur',
  product: 'plan_cantina',
  unit_amount: 2_900,
  currency: 'eur',
  recurring: { interval: 'month' },
  ...overrides,
});

const within = async (seed, body) => {
  const stripe = await fakeStripe(seed);

  try {
    await body(stripe);
  } finally {
    await stripe.close();
  }
};

describe('the guard rails', () => {
  it('refuses to run without a key', async () => {
    const { status, output } = await run([], {});

    expect(status).toBe(1);
    expect(output).toContain('STRIPE_SECRET_KEY is not set');
  });

  it('refuses a value that is not a Stripe key, without printing it', async () => {
    const notAKey = `pk_test_${randomBytes(8).toString('hex')}`;
    const { status, output } = await run([], { STRIPE_SECRET_KEY: notAKey });

    expect(status).toBe(1);
    expect(output).toContain('does not look like a Stripe secret or restricted key');
    expect(output).not.toContain(notAKey);
  });

  it('refuses a live key unless --live says so, before asking Stripe anything', async () => {
    await within({}, async (stripe) => {
      const refused = await run([], {
        STRIPE_SECRET_KEY: keyFor('live'),
        STRIPE_API_BASE: stripe.base,
      });

      expect(refused.status).toBe(1);
      expect(refused.output).toContain('That is a live-mode key');
      expect(stripe.requests).toEqual([]);

      const allowed = await run(['--live'], {
        STRIPE_SECRET_KEY: keyFor('live'),
        STRIPE_API_BASE: stripe.base,
      });

      expect(allowed.status).toBe(0);
      expect(allowed.stdout).toContain('LIVE mode, dry run');
    });
  });

  it.each([
    ['another host over https', 'https://api.stripe.example'],
    ['another host over plain http', 'http://api.stripe.example'],
    ['this machine’s name, over https', 'https://localhost:12111'],
    ['something that is not a URL', 'api.stripe.com'],
  ])('sends the key nowhere but this machine: refuses %s', async (_what, base) => {
    const { status, output } = await run([], {
      STRIPE_SECRET_KEY: keyFor('test'),
      STRIPE_API_BASE: base,
    });

    expect(status).toBe(1);
    expect(output).toContain('STRIPE_API_BASE may only point at this machine');
  });

  it('refuses an argument it does not know, rather than ignoring a typo of --apply', async () => {
    const { status, output } = await run(['--aply'], { STRIPE_SECRET_KEY: keyFor('test') });

    expect(status).toBe(1);
    expect(output).toContain('Unknown argument --aply');
  });
});

describe('an empty account', () => {
  it('is only read on a dry run, and the plan is printed', async () => {
    await within({}, async (stripe) => {
      const key = keyFor('test');
      const { status, stdout } = await run([], {
        STRIPE_SECRET_KEY: key,
        STRIPE_API_BASE: stripe.base,
      });

      expect(status).toBe(0);
      expect(stdout).toContain('test mode, dry run');
      expect(stdout).toMatch(
        /CANTINA\s+cantina_monthly_eur\s+€29\.00\/month\s+create product and price/u,
      );
      expect(stdout).toMatch(
        /ECOMMERCE\s+ecommerce_monthly_eur\s+€79\.00\/month\s+create product and price/u,
      );
      expect(stdout).toMatch(
        /MESSAGES_1000\s+messages_1000_eur\s+€15\.00 once\s+create product and price/u,
      );
      expect(stdout).toContain('Nothing written');
      expect(stripe.writes()).toEqual([]);
      expect(stdout).not.toContain(key);
    });
  });

  it('gets both plans and the top-up on --apply, encoded as Stripe reads them', async () => {
    await within({}, async (stripe) => {
      const key = keyFor('test');
      const { status, stdout } = await run(['--apply'], {
        STRIPE_SECRET_KEY: key,
        STRIPE_API_BASE: stripe.base,
      });

      expect(status).toBe(0);

      const writes = stripe.writes().map(({ path, params }) => [path, Object.fromEntries(params)]);

      expect(writes).toEqual([
        ['/v1/products', { id: 'plan_cantina', name: 'Cantina', 'metadata[plan]': 'CANTINA' }],
        [
          '/v1/prices',
          {
            product: 'plan_cantina',
            lookup_key: 'cantina_monthly_eur',
            transfer_lookup_key: 'true',
            nickname: 'Cantina',
            unit_amount: '2900',
            currency: 'eur',
            'recurring[interval]': 'month',
            'metadata[plan]': 'CANTINA',
          },
        ],
        [
          '/v1/products',
          { id: 'plan_ecommerce', name: 'E-commerce', 'metadata[plan]': 'ECOMMERCE' },
        ],
        [
          '/v1/prices',
          {
            product: 'plan_ecommerce',
            lookup_key: 'ecommerce_monthly_eur',
            transfer_lookup_key: 'true',
            nickname: 'E-commerce',
            unit_amount: '7900',
            currency: 'eur',
            'recurring[interval]': 'month',
            'metadata[plan]': 'ECOMMERCE',
          },
        ],
        [
          '/v1/products',
          {
            id: 'top_up_messages_1000',
            name: '1,000 messages',
            'metadata[top_up]': 'MESSAGES_1000',
          },
        ],
        [
          '/v1/prices',
          {
            product: 'top_up_messages_1000',
            lookup_key: 'messages_1000_eur',
            transfer_lookup_key: 'true',
            nickname: '1,000 messages',
            unit_amount: '1500',
            currency: 'eur',
            'metadata[top_up]': 'MESSAGES_1000',
          },
        ],
      ]);
      expect(stdout).toMatch(/CANTINA\s+create\s+price_1/u);
      expect(stdout).toMatch(/ECOMMERCE\s+create\s+price_2/u);
      expect(stdout).toMatch(/MESSAGES_1000\s+create\s+price_3/u);
      expect(stdout).not.toContain(key);
    });
  });

  it('asks for active prices under our keys, authenticated and on the pinned version', async () => {
    await within({}, async (stripe) => {
      const key = keyFor('test');

      await run(['--apply'], { STRIPE_SECRET_KEY: key, STRIPE_API_BASE: stripe.base });

      const [list] = stripe.requests;

      expect(list.path).toBe('/v1/prices');
      expect(list.params.get('active')).toBe('true');
      expect([0, 1, 2].map((index) => list.params.get(`lookup_keys[${String(index)}]`))).toEqual([
        'cantina_monthly_eur',
        'ecommerce_monthly_eur',
        'messages_1000_eur',
      ]);

      for (const request of stripe.requests) {
        expect(request.headers.authorization).toBe(`Bearer ${key}`);
        expect(request.headers['stripe-version']).toBe('2026-08-26.dahlia');
      }
    });
  });

  it('gives every write an idempotency key of its own, derived from what it writes', async () => {
    await within({}, async (stripe) => {
      await run(['--apply'], { STRIPE_SECRET_KEY: keyFor('test'), STRIPE_API_BASE: stripe.base });

      const keys = stripe.writes().map((request) => request.headers['idempotency-key']);

      expect(keys).toHaveLength(6);
      for (const idempotency of keys) expect(idempotency).toMatch(/^p5-01-[0-9a-f]{40}$/u);
      expect(new Set(keys).size).toBe(6);
    });
  });
});

describe('running it twice', () => {
  it('creates nothing the second time', async () => {
    await within({}, async (stripe) => {
      const env = { STRIPE_SECRET_KEY: keyFor('test'), STRIPE_API_BASE: stripe.base };

      await run(['--apply'], env);
      const written = stripe.writes().length;
      const again = await run(['--apply'], env);

      expect(again.status).toBe(0);
      expect(stripe.writes()).toHaveLength(written);
      expect(again.stdout).toMatch(/CANTINA\s+unchanged\s+price_1/u);
      expect(again.stdout).toMatch(/ECOMMERCE\s+unchanged\s+price_2/u);
      expect(again.stdout).toMatch(/MESSAGES_1000\s+unchanged\s+price_3/u);
    });
  });
});

describe('a price that disagrees with plans.ts', () => {
  it('fails the dry run and names what differs', async () => {
    await within({ prices: [cantina({ unit_amount: 2_500 })] }, async (stripe) => {
      const { status, output } = await run([], {
        STRIPE_SECRET_KEY: keyFor('test'),
        STRIPE_API_BASE: stripe.base,
      });

      expect(status).toBe(1);
      expect(output).toMatch(
        /CANTINA\s+cantina_monthly_eur\s+€29\.00\/month\s+DIFFERS \(amount\)\s+price_live_cantina/u,
      );
      expect(output).toContain('--apply --reprice');
    });
  });

  it('stops --apply before writing anything, the missing plan included', async () => {
    await within({ prices: [cantina({ unit_amount: 2_500 })] }, async (stripe) => {
      const { status, output } = await run(['--apply'], {
        STRIPE_SECRET_KEY: keyFor('test'),
        STRIPE_API_BASE: stripe.base,
      });

      expect(status).toBe(1);
      expect(output).toContain(
        'Stripe disagrees with plans.ts, so nothing was changed: CANTINA (amount)',
      );
      expect(stripe.writes()).toEqual([]);
    });
  });

  it('is replaced under --reprice, and the operator is told what became of the old one', async () => {
    await within(
      {
        prices: [cantina({ unit_amount: 2_500 })],
        products: ['plan_cantina', 'plan_ecommerce', 'top_up_messages_1000'],
      },
      async (stripe) => {
        const { status, stdout } = await run(['--apply', '--reprice'], {
          STRIPE_SECRET_KEY: keyFor('test'),
          STRIPE_API_BASE: stripe.base,
        });

        expect(status).toBe(0);
        expect(stripe.writes().map(({ path, params }) => [path, params.get('lookup_key')])).toEqual(
          [
            ['/v1/prices', 'cantina_monthly_eur'],
            ['/v1/prices', 'ecommerce_monthly_eur'],
            ['/v1/prices', 'messages_1000_eur'],
          ],
        );
        expect(stdout).toMatch(/CANTINA\s+reprice\s+price_1/u);
        expect(stdout).toContain('price_live_cantina keeps its subscribers');
      },
    );
  });
});

describe('when Stripe refuses', () => {
  it('stops with Stripe’s reason and never repeats the key, even when Stripe does', async () => {
    const key = keyFor('test');

    await within(
      {
        refuseWith: {
          status: 401,
          error: { type: 'invalid_request_error', message: `Invalid API Key provided: ${key}` },
        },
      },
      async (stripe) => {
        const { status, output } = await run([], {
          STRIPE_SECRET_KEY: key,
          STRIPE_API_BASE: stripe.base,
        });

        expect(status).toBe(1);
        expect(output).toContain('Stripe refused while listing prices (HTTP 401)');
        expect(output).toContain('Invalid API Key provided: [redacted]');
        expect(output).not.toContain(key);
      },
    );
  });

  it('stops when a product cannot be read, rather than taking it for missing', async () => {
    /*
     * A restricted key without read access to Products answers 403. Taken for
     * "no such product", the run would go on to create one — and fail there,
     * or worse, succeed with a key that can write what it cannot read.
     */
    await within(
      {
        refuseProducts: {
          status: 403,
          error: {
            type: 'invalid_request_error',
            message: 'The provided key does not have access.',
          },
        },
      },
      async (stripe) => {
        const { status, output } = await run([], {
          STRIPE_SECRET_KEY: ['rk', 'test', randomBytes(16).toString('hex')].join('_'),
          STRIPE_API_BASE: stripe.base,
        });

        expect(status).toBe(1);
        expect(output).toContain('Stripe refused while reading product plan_cantina (HTTP 403)');
        expect(stripe.writes()).toEqual([]);
      },
    );
  });

  it('says so when Stripe cannot be reached at all', async () => {
    const stripe = await fakeStripe();

    await stripe.close();

    const { status, output } = await run([], {
      STRIPE_SECRET_KEY: keyFor('test'),
      STRIPE_API_BASE: stripe.base,
    });

    expect(status).toBe(1);
    expect(output).toContain('Could not reach Stripe');
  });
});
