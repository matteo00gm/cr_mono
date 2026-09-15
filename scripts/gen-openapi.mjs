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
const { DASHBOARD_ROUTES, responseJsonSchema } =
  await import('../apps/api/dist/surfaces/dashboard.js');
const { DASHBOARD_PREFIX, WIDGET_PREFIX } = await import('../apps/api/dist/routes.js');
const { WIDGET_ROUTES } = await import('../apps/api/dist/surfaces/widget.js');
const { registeredRoutes, routeKey } = await import('../apps/api/dist/middleware/capability.js');
const { WIDGET_REFUSED } = await import('../apps/api/dist/middleware/cors.js');
const { WIDGET_TOKEN_REFUSED } = await import('../apps/api/dist/widget-session.js');

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

/**
 * Which table documents an endpoint, if any.
 *
 * The widget's CORS preflights are declared for access (P0-49) and deliberately
 * not documented: an `OPTIONS` answer has no body to describe, and a reference
 * listing one would be describing the browser rather than the API.
 */
const tableFor = (endpoint) => {
  if (endpoint.path.startsWith(DASHBOARD_PREFIX)) return DASHBOARD_ROUTES;
  if (endpoint.path.startsWith(WIDGET_PREFIX) && endpoint.method !== 'OPTIONS') {
    return WIDGET_ROUTES;
  }
  return undefined;
};

for (const endpoint of endpoints) {
  const table = tableFor(endpoint);
  if (table === undefined) continue;

  const doc = table.get(endpoint.key);
  if (!doc) {
    /*
     * Unreachable in practice, and kept anyway. `createApp` runs P0-49's boot
     * check, which throws on an undeclared route before this ever executes —
     * verified by planting one. This branch is the second line of a defence
     * that currently has a first, and it stops being redundant the moment a
     * route is declared for access but not documented.
     */
    problems.push(`${endpoint.key}: served by the router, absent from its route table`);
    continue;
  }
  if (!doc.summary?.trim()) problems.push(`${endpoint.key}: empty summary`);
  if (!doc.description?.trim()) problems.push(`${endpoint.key}: empty description`);
  if (doc.example === undefined) problems.push(`${endpoint.key}: no example`);
  if (!doc.response) problems.push(`${endpoint.key}: no response schema`);
}

for (const key of [...DASHBOARD_ROUTES.keys(), ...WIDGET_ROUTES.keys()]) {
  if (!seen.has(key)) problems.push(`${key}: described in a route table, served by nothing`);
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

const DASHBOARD_ERRORS = { 401: errorResponse, 403: errorResponse };

/**
 * The widget's refusals, which are not the dashboard's.
 *
 * A widget request is refused for its key and `Origin` (403) or its rate (429),
 * and the session mint also for a previous token that belongs elsewhere or was
 * revoked (401, P2-12a). The 403 is one answer for an
 * unknown key and a stolen one alike, and the reference says so rather than
 * inviting a reader to look for the difference.
 */
const widgetError = (description, code, message) => ({
  description,
  content: {
    'application/json': {
      example: { error: { code, message, requestId: '5b8c1f0e-6d2a-4c93-9a71-3f0e6d2a4c93' } },
    },
  },
});

const WIDGET_ERRORS = {
  401: widgetError(
    'The token sent to continue a session belongs to another site or another tenant, or was ' +
      'revoked. The same answer whatever the reason; mint again without it to start a new session.',
    'unauthenticated',
    WIDGET_TOKEN_REFUSED,
  ),
  403: widgetError(
    "The key and the request's Origin do not belong to one tenant. The same answer whatever " +
      'the reason, and it carries no CORS headers, so a browser script cannot read it.',
    'forbidden',
    WIDGET_REFUSED,
  ),
  429: widgetError(
    'A rate limit refused the request. `Retry-After` says when to try again.',
    'rate_limited',
    'Too many requests. Try again shortly.',
  ),
};

/**
 * The error responses one route documents (review fix).
 *
 * A route that lists `refusals` gets exactly those, taken from its surface's
 * table; one that does not gets the surface's usual set. A surface marker
 * refuses nothing, and documenting a 401 or a 429 on it sends a reader looking
 * for a guard that is not there. A refusal the surface has no description for
 * fails generation rather than being dropped.
 */
const refusalsOf = (endpoint, doc, errors) => {
  if (doc.refusals === undefined) return errors;

  return Object.fromEntries(
    doc.refusals.map((status) => {
      if (errors[status] === undefined) {
        die(`${endpoint.key}: refuses with ${String(status)}, which its surface does not describe`);
      }
      return [status, errors[status]];
    }),
  );
};

const operationFor = (endpoint, doc, errors) => {
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
        content: {
          'application/json': {
            // The schema is what P0-63's client compiles against; the example
            // is what a human reads. Both, because neither replaces the other.
            schema: responseJsonSchema(doc),
            example: doc.example,
          },
        },
      },
      ...refusalsOf(endpoint, doc, errors),
    }),
  };
};

const documentFor = (title, description, prefix, table, errors) => {
  const paths = {};

  for (const endpoint of endpoints) {
    if (!endpoint.path.startsWith(prefix)) continue;
    const doc = table.get(endpoint.key);
    if (!doc) continue;

    paths[endpoint.path] ??= {};
    paths[endpoint.path][endpoint.method.toLowerCase()] = operationFor(endpoint, doc, errors);
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
    DASHBOARD_ERRORS,
  ),
  widget: documentFor(
    'Sommelier widget API',
    'Public, called from sellers’ own sites. Authenticated by origin-bound tokens ' +
      'rather than cookies; this surface accepts no credentials.',
    WIDGET_PREFIX,
    WIDGET_ROUTES,
    WIDGET_ERRORS,
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
