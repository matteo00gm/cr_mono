#!/usr/bin/env node
/**
 * Builds a Stripe account's plan catalogue from `plans.ts` (P5-01).
 *
 *   STRIPE_SECRET_KEY=… node scripts/stripe-setup.mjs                    what it would do
 *   STRIPE_SECRET_KEY=… node scripts/stripe-setup.mjs --apply            do it
 *   STRIPE_SECRET_KEY=… node scripts/stripe-setup.mjs --apply --reprice  replace a price that disagrees
 *
 * A live-mode key is refused unless `--live` is passed too: the account real
 * customers pay into is used only when somebody said so.
 *
 * **A dry run unless told otherwise.** It reads the account, prints every step,
 * and writes nothing without `--apply`. A run that finds a price disagreeing
 * with `plans.ts` exits 1 and writes nothing at all (see `applyCatalog`).
 *
 * **Idempotent**: a second `--apply` finds every price under its lookup key and
 * creates nothing. Every write also carries an idempotency key derived from
 * what it writes, so a retry after a dropped connection is not a duplicate.
 *
 * **Nothing to store afterwards.** Checkout finds a plan's price by its lookup
 * key; a price id kept in configuration would go stale the day a plan is
 * repriced, because a Stripe price is immutable and a new amount is a new price.
 *
 * The key is read from the environment and never printed — not in a table, not
 * in an error, not in Stripe's own error text, which is redacted before it is
 * shown. Use a restricted key with write access to Products and Prices only.
 *
 * Needs `pnpm build` first: the reconciliation is imported from
 * `packages/core/dist`, the same code the tests exercise.
 */
import { createHash } from 'node:crypto';
import process from 'node:process';
import { URLSearchParams } from 'node:url';

import { die, table } from './lib/report.mjs';

const { applyCatalog, CatalogConflictError, planCatalog, STRIPE_API_VERSION } =
  await import('../packages/core/dist/billing/stripe-catalog.js');
const { PLANS } = await import('../packages/core/dist/plans.js');

const FLAGS = new Set(['--apply', '--reprice', '--live']);
const args = process.argv.slice(2);

for (const arg of args) {
  if (!FLAGS.has(arg)) die(`Unknown argument ${arg}.`, `Known: ${[...FLAGS].join(', ')}.`);
}

const apply = args.includes('--apply');
const reprice = args.includes('--reprice');

const key = process.env.STRIPE_SECRET_KEY ?? '';

if (key === '') {
  die(
    'STRIPE_SECRET_KEY is not set.',
    'Use a restricted key with write access to Products and Prices, from the stage’s own account.',
  );
}

/** `sk_` or `rk_`, then the mode. The value itself is never echoed back. */
const mode = /^(?:sk|rk)_(test|live)_/u.exec(key)?.[1];

if (mode === undefined) {
  die(
    'STRIPE_SECRET_KEY does not look like a Stripe secret or restricted key.',
    'It should begin sk_test_, sk_live_, rk_test_ or rk_live_. Its value is not printed.',
  );
}

if (mode === 'live' && !args.includes('--live')) {
  die(
    'That is a live-mode key.',
    'Pass --live as well to read or change the account real customers pay into.',
  );
}

/**
 * Stripe, or a stand-in on this machine for the script's own tests.
 *
 * **Loopback only**, because the key goes wherever this points: an override
 * that accepted any host would be one mistyped variable away from sending a
 * secret key to it.
 */
const base = (() => {
  const override = process.env.STRIPE_API_BASE;

  if (override === undefined) return 'https://api.stripe.com';

  const url = URL.canParse(override) ? new URL(override) : undefined;

  if (url?.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    die(
      'STRIPE_API_BASE may only point at this machine.',
      'It exists for the script’s own tests; anywhere else would be handed the key.',
    );
  }

  return url.origin;
})();

/**
 * A stop after Stripe has been asked something.
 *
 * **Thrown, never `process.exit()`**: on Windows, exiting while `fetch` still
 * holds a pooled socket trips a libuv assertion, and the process dies with
 * 0xC0000409 instead of the status it was given — so an operator's refused run
 * reads as a crash, and a clean dry run does too. The guard rails above use
 * `die`, because nothing has been fetched when they run.
 */
class Refusal extends Error {
  constructor(label, detail) {
    super(label);
    this.detail = detail;
  }
}

/** Removes the key from anything about to be shown, however it got there. */
const redact = (text) => String(text).replaceAll(key, '[redacted]');

/** Stripe's form encoding: nested objects as `a[b]`, arrays as `a[]`. */
const encode = (params, prefix = '') =>
  Object.entries(params).flatMap(([name, value]) => {
    const field = prefix === '' ? name : `${prefix}[${name}]`;

    if (Array.isArray(value)) return value.map((item) => [`${field}[]`, String(item)]);
    if (typeof value === 'object' && value !== null) return encode(value, field);

    return [[field, String(value)]];
  });

const request = async (method, path, params = {}) => {
  const body = new URLSearchParams(encode(params)).toString();
  const headers = {
    authorization: `Bearer ${key}`,
    'stripe-version': STRIPE_API_VERSION,
  };

  if (method === 'POST') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['idempotency-key'] =
      `p5-01-${createHash('sha256').update(`${path}?${body}`).digest('hex').slice(0, 40)}`;
  }

  let response;

  try {
    response = await fetch(
      method === 'GET' && body !== '' ? `${base}${path}?${body}` : `${base}${path}`,
      { method, headers, body: method === 'POST' ? body : undefined },
    );
  } catch (error) {
    throw new Refusal('Could not reach Stripe.', redact(error.cause?.message ?? error.message));
  }

  const json = await response.json().catch(() => ({}));

  return { status: response.status, json };
};

/** Stops on anything but success, in Stripe's own words with the key taken out. */
const expectOk = ({ status, json }, doing) => {
  if (status >= 200 && status < 300) return json;

  const { type, code, message } = json.error ?? {};

  throw new Refusal(
    `Stripe refused while ${doing} (HTTP ${String(status)}${code ? `, ${code}` : ''}).`,
    redact(message ?? type ?? 'No message.'),
  );
};

const asPrice = (price) => ({
  id: price.id,
  lookupKey: price.lookup_key ?? null,
  productId: typeof price.product === 'string' ? price.product : price.product.id,
  unitAmount: price.unit_amount ?? null,
  currency: price.currency,
  interval: price.recurring?.interval ?? null,
});

/** The port `planCatalog` and `applyCatalog` read and write through. */
const catalog = {
  async pricesByLookupKey(keys) {
    const json = expectOk(
      await request('GET', '/v1/prices', { active: true, limit: 100, lookup_keys: keys }),
      'listing prices',
    );

    return json.data.map(asPrice);
  },

  async hasProduct(id) {
    const response = await request('GET', `/v1/products/${encodeURIComponent(id)}`);

    if (response.status === 404 && response.json.error?.code === 'resource_missing') return false;

    expectOk(response, `reading product ${id}`);

    return true;
  },

  async createProduct(product) {
    expectOk(await request('POST', '/v1/products', product), `creating product ${product.id}`);
  },

  async createPrice(price) {
    const json = expectOk(
      await request('POST', '/v1/prices', {
        product: price.productId,
        lookup_key: price.lookupKey,
        transfer_lookup_key: true,
        nickname: price.nickname,
        unit_amount: price.unitAmount,
        currency: price.currency,
        recurring: { interval: price.interval },
        metadata: price.metadata,
      }),
      `creating the ${price.lookupKey} price`,
    );

    return asPrice(json);
  },
};

const euros = (plan) => `€${(plan.amountCents / 100).toFixed(2)}/${plan.interval}`;

const stepCells = (step) => {
  switch (step.kind) {
    case 'unchanged':
      return ['unchanged', step.priceId];
    case 'create':
      return [step.productExists ? 'create price' : 'create product and price', ''];
    case 'reprice':
      return [`replace (${step.fields.join(', ')})`, step.previous.id];
    default:
      return [`DIFFERS (${step.fields.join(', ')})`, step.previous.id];
  }
};

const main = async () => {
  const steps = await planCatalog(catalog, { reprice });

  console.log(
    `\n  Stripe catalogue — ${mode === 'live' ? 'LIVE' : 'test'} mode, ${apply ? 'applying' : 'dry run'}\n`,
  );
  console.log(
    table(
      ['Plan', 'Lookup key', 'Price', 'Step', 'Live price'],
      steps.map((step) => [
        step.plan,
        PLANS[step.plan].lookupKey,
        euros(PLANS[step.plan]),
        ...stepCells(step),
      ]),
    ),
  );

  if (!apply) {
    if (steps.some((step) => step.kind === 'differs')) {
      throw new Refusal(
        'Stripe disagrees with plans.ts.',
        'Run again with --apply --reprice to replace those prices for new subscribers.',
      );
    }

    console.log('\n  Nothing written. Run again with --apply to make these changes.\n');

    return;
  }

  let results;

  try {
    results = await applyCatalog(catalog, steps);
  } catch (error) {
    if (error instanceof CatalogConflictError) throw new Refusal(error.message);
    throw error;
  }

  console.log(
    `\n${table(
      ['Plan', 'Step', 'Price id'],
      results.map((result) => [result.plan, result.kind, result.priceId]),
    )}\n`,
  );

  for (const step of steps) {
    if (step.kind === 'reprice') {
      console.log(
        `  ${step.previous.id} keeps its subscribers and no longer holds ` +
          `${PLANS[step.plan].lookupKey}. Archive it in the Dashboard once none remain.`,
      );
    }
  }

  console.log('  Checkout finds these by lookup key; there is no price id to store.\n');
};

try {
  await main();
} catch (error) {
  if (!(error instanceof Refusal)) throw error;

  console.error(`\n  ${error.message}\n`);
  if (error.detail) console.error(`  ${error.detail}\n`);
  process.exitCode = 1;
}
