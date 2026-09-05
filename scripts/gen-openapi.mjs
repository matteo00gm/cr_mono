#!/usr/bin/env node
/**
 * Generates `docs/api/openapi.json` from the route table (P0-62).
 *
 * §8.4: hand-written API docs are the fastest-rotting artifact in any codebase.
 * Both inputs already exist for other reasons — the route table for P0-50's
 * capability matrix, the contracts for validation — so the reference is nearly
 * free and **structurally cannot diverge from what the server does**.
 *
 * Routes are enumerated from the built application, not from a list kept here.
 * A route the router serves and the table does not describe fails the
 * completeness check, and a route described but not served fails it too.
 *
 * Two surfaces, documented separately: `/v1/widget/*` is public-facing and
 * `/v1/dashboard/*` is not, and merging them would put an internal reference in
 * front of sellers' developers.
 *
 * Usage:
 *   node scripts/gen-openapi.mjs            # write docs/api/openapi.json
 *   node scripts/gen-openapi.mjs --check    # fail if the committed file differs
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { die as reportDie } from './lib/report.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'api', 'openapi.json');

const die = (msg) => reportDie('OpenAPI generation failed: ' + msg);

/*
 * The app is imported from `dist`, so this needs `pnpm build` first — the same
 * requirement the integration suite has, and for the same reason.
 */
const { createApp } = await import('../apps/api/dist/app.js');
const { DASHBOARD_ROUTES } = await import('../apps/api/dist/surfaces/dashboard.js');
const { DASHBOARD_PREFIX, WIDGET_PREFIX } = await import('../apps/api/dist/routes.js');
const { registeredRoutes, routeKey } = await import('../apps/api/dist/middleware/capability.js');

/** A stand-in: constructing the real Better Auth would open a connection. */
const stubAuth = {
  handler: () => Promise.resolve(new Response()),
  api: { getSession: () => Promise.resolve(null) },
};

const app = createApp({ auth: stubAuth, readMemberships: () => Promise.resolve([]) });

/**
 * Concrete endpoints, deduplicated across handler entries.
 *
 * `registeredRoutes` already drops middleware; a route with a capability guard
 * appears twice, once for the guard and once for the handler.
 */
const endpoints = [];
const seen = new Set();
for (const route of registeredRoutes(app)) {
  const key = routeKey(route.method, route.path);
  if (seen.has(key)) continue;
  seen.add(key);
  endpoints.push({ ...route, key });
}

// ------------------------------------------------------------- completeness
const problems = [];

for (const endpoint of endpoints) {
  if (!endpoint.path.startsWith(DASHBOARD_PREFIX)) continue;

  const doc = DASHBOARD_ROUTES.get(endpoint.key);
  if (!doc) {
    /*
     * Unreachable in practice, and kept anyway. `createApp` runs P0-49's boot
     * check, which throws on an undeclared route before this ever executes —
     * verified by planting one. This branch is the second line of a defence
     * that currently has a first, and it stops being redundant the moment a
     * route is declared for access but not documented.
     */
    problems.push(`${endpoint.key}: served by the router, absent from DASHBOARD_ROUTES`);
    continue;
  }
  if (!doc.summary?.trim()) problems.push(`${endpoint.key}: empty summary`);
  if (!doc.description?.trim()) problems.push(`${endpoint.key}: empty description`);
  if (doc.example === undefined) problems.push(`${endpoint.key}: no example`);
}

for (const key of DASHBOARD_ROUTES.keys()) {
  if (!seen.has(key)) problems.push(`${key}: described in DASHBOARD_ROUTES, served by nothing`);
}

if (problems.length > 0) {
  die(
    'the route table and the router disagree, or a route is undocumented:\n    ' +
      problems.join('\n    ') +
      '\n\n  A reference where half the routes are blank is decorative. Every route needs\n' +
      '  a summary, a description and an example (P0-62).',
  );
}

// ------------------------------------------------------------------- emit
/**
 * Sorted at every level.
 *
 * Unstable key ordering would make the drift check fail for no reason, and a
 * check that fails spuriously gets disabled — which is how this artifact dies.
 */
const sortedEntries = (object) =>
  Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));

const errorResponse = {
  description: 'The request failed. `code` is stable; `message` is for a human.',
  content: {
    'application/json': {
      example: {
        error: {
          code: 'forbidden',
          message: 'This role cannot billing manage.',
          requestId: '5b8c1f0e-6d2a-4c93-9a71-3f0e6d2a4c93',
        },
      },
    },
  },
};

const operationFor = (endpoint, doc) => {
  const capability = doc.access.kind === 'capability' ? doc.access.capability : undefined;

  return {
    summary: doc.summary,
    /*
     * The capability is in the document on purpose, and it is the part a reader
     * cannot get anywhere else: it says *who may call this*, which is otherwise
     * only discoverable by trying.
     */
    description:
      doc.description +
      (capability
        ? `\n\nRequires the \`${capability}\` capability.`
        : `\n\nNo capability required. ${doc.access.reason}`),
    operationId: `${endpoint.method.toLowerCase()}${endpoint.path
      .split('/')
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join('')}`,
    ...(capability ? { 'x-required-capability': capability } : {}),
    responses: sortedEntries({
      200: {
        description: doc.summary,
        content: { 'application/json': { example: doc.example } },
      },
      401: errorResponse,
      403: errorResponse,
    }),
  };
};

const documentFor = (title, description, prefix, table) => {
  const paths = {};

  for (const endpoint of endpoints) {
    if (!endpoint.path.startsWith(prefix)) continue;
    const doc = table.get(endpoint.key);
    if (!doc) continue;

    paths[endpoint.path] ??= {};
    paths[endpoint.path][endpoint.method.toLowerCase()] = operationFor(endpoint, doc);
  }

  return {
    openapi: '3.1.0',
    info: { title, description, version: '0.0.0' },
    paths: sortedEntries(
      Object.fromEntries(Object.entries(paths).map(([path, ops]) => [path, sortedEntries(ops)])),
    ),
  };
};

const document = {
  dashboard: documentFor(
    'Sommelier dashboard API',
    'Authenticated by a session cookie. The tenant is resolved from a `memberships` row ' +
      'for the signed-in user and never from request input, so a tenant id in a body, ' +
      'query or header is ignored.',
    DASHBOARD_PREFIX,
    DASHBOARD_ROUTES,
  ),
  widget: documentFor(
    'Sommelier widget API',
    'Public, called from sellers’ own sites. Authenticated by origin-bound tokens ' +
      'rather than cookies; this surface accepts no credentials.',
    WIDGET_PREFIX,
    new Map(),
  ),
};

const json = JSON.stringify(document, null, 2) + '\n';

if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) die(`${OUT} does not exist. Run \`pnpm openapi\` and commit it.`);

  if (readFileSync(OUT, 'utf8') !== json) {
    die(
      'the committed OpenAPI document is stale.\n\n' +
        '  Run `pnpm openapi` and commit the result. The document is generated from the\n' +
        '  route table, so a difference means the API changed and the reference did not.',
    );
  }
  console.log('\n  OpenAPI document is current.\n');
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json, 'utf8');
  console.log(`\n  Wrote ${OUT}\n`);
}
