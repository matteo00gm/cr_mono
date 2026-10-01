#!/usr/bin/env node
/**
 * One winery in every billing state, against a running local stack (P5-14).
 *
 *   DATABASE_URL=<app_rw url> pnpm seed:states            seed, and print where each one is
 *   DATABASE_URL=<app_rw url> pnpm seed:states --serve    and serve a storefront per state
 *
 * **By the webhook path.** The paid states are reached by Stripe-shaped events
 * recorded through the same port a signed delivery reaches, so the state
 * machine is what got each one there (`packages/testing/src/seed-states.ts`).
 *
 * **Never production.** Refused when `SST_STAGE` is `production`: fixture
 * wineries in the account real customers use are a mess nobody asked for, and
 * the events it records are test-mode events a production stage refuses anyway.
 *
 * `--serve` puts a storefront on each fixture's origin (ports 4201–4208), each
 * carrying the widget against `API_ORIGIN` (default `http://localhost:3001`).
 * Needs `pnpm build` and the widget bundle (`pnpm --filter @catalogorosso/widget build:bundle`).
 */
import process from 'node:process';

import { die, table } from './lib/report.mjs';

const FLAGS = new Set(['--serve']);
const args = process.argv.slice(2);

for (const arg of args) {
  if (!FLAGS.has(arg)) die(`Unknown argument ${arg}.`, `Known: ${[...FLAGS].join(', ')}.`);
}

if (process.env.SST_STAGE === 'production') {
  die('Refusing to seed fixture wineries into production.', 'Point DATABASE_URL at a local stack.');
}

if (!process.env.DATABASE_URL) {
  die('DATABASE_URL is not set.', 'Use the app_rw URL of the stack to seed, as the API does.');
}

const { seedStates, startHostPages, bundleDirectory } =
  await import('../packages/testing/dist/index.js');
const { createDevBillingPort } = await import('../apps/api/dist/dev-billing.js');
const { createStripeEventsPort } = await import('../apps/api/dist/stripe-events.js');
const { createBillingEffect } = await import('../apps/api/dist/billing-events.js');

const dev = createDevBillingPort({
  stripeEvents: createStripeEventsPort({ apply: createBillingEffect({ livemode: false }) }),
});

const seeded = await seedStates({ transition: (tenantId, step) => dev.apply(tenantId, step) });

console.log(
  `\n${table(
    ['Fixture', 'Status', 'Widget', 'Storefront', 'Public key'],
    seeded.map((state) => [state.slug, state.status, state.widget, state.origin, state.publicKey]),
  )}\n`,
);

if (args.includes('--serve')) {
  const api = process.env.API_ORIGIN ?? 'http://localhost:3001';

  for (const state of seeded) {
    await startHostPages({
      port: Number(new URL(state.origin).port),
      api,
      widgetKey: state.publicKey,
      bundleDir: bundleDirectory(),
    });
  }

  console.log(`  Serving every storefront against ${api}. Ctrl+C to stop.\n`);
} else {
  process.exit(0);
}
