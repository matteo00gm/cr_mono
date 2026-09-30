import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { readMembershipsForUser } from '@catalogorosso/db';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createDomainsPort } from '../src/domains.js';
import { createKeysPort } from '../src/keys.js';
import { createMembersPort } from '../src/members.js';
import { createProductsPort } from '../src/products.js';
import { DASHBOARD_ROUTES } from '../src/surfaces/dashboard.js';
import { signedIn } from './support/auth.js';

/**
 * The IDOR matrix (P4-15, §3.5).
 *
 * **Every dashboard route that takes a resource id**, asked by winery B for
 * winery A's real resource, must answer 404 — with a body identical, request id
 * aside, to the one for an id that never existed. A 403 there, or any
 * difference at all, tells an attacker the resource exists.
 *
 * Real Postgres and the real ports, because the property lives in the policies
 * and in how each port turns "no row" into a refusal: nothing here is faked but
 * the session. Each request is then made again **as winery A**, and must not be
 * a 404 — so the refusal is proved to be about the tenant, and not about a
 * mistyped id or a body the route never accepted.
 *
 * The routes are read off the route table, and a test fails if one taking an id
 * is missing from the matrix: a new route cannot skip it by being new.
 */

let harness: TestDatabase | undefined;

const admin = () => {
  if (harness === undefined) throw new Error('no database');
  return harness.adminDb;
};

interface Seeded {
  readonly tenantA: string;
  readonly tenantB: string;
  readonly ownerA: string;
  readonly ownerB: string;
  readonly editorA: string;
  readonly productA: string;
  readonly domainA: string;
  readonly invitationA: string;
  /** A's claim, on notice, served on B — so B can see it, and still must get 404. */
  readonly claimA: string;
  /** A notice served on A by B — so B, the claimant, is the one who must get 404. */
  readonly servedA: string;
}

let seeded: Seeded;

const user = async (label: string): Promise<string> => {
  const id = `user_${label}_${randomUUID().slice(0, 8)}`;
  await admin().execute(sql`
    INSERT INTO auth_users (id, name, email, two_factor_enabled)
    VALUES (${id}, ${label}, ${`${id}@example.test`}, true)
  `);
  return id;
};

const tenant = async (label: string): Promise<string> => {
  const id = randomUUID();
  await admin().execute(sql`
    INSERT INTO tenants (id, name, slug, status, stripe_subscription_id) VALUES (${id}, ${label}, ${`${label}-${id}`}, 'ACTIVE', 'sub_' || gen_random_uuid())
  `);
  return id;
};

const member = (tenantId: string, userId: string, role: 'OWNER' | 'EDITOR') =>
  admin().execute(sql`
    INSERT INTO memberships (tenant_id, user_id, role) VALUES (${tenantId}, ${userId}, ${role})
  `);

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');

  const tenantA = await tenant('cantina-a');
  const tenantB = await tenant('cantina-b');
  const ownerA = await user('owner-a');
  const ownerB = await user('owner-b');
  const editorA = await user('editor-a');

  await member(tenantA, ownerA, 'OWNER');
  await member(tenantA, editorA, 'EDITOR');
  await member(tenantB, ownerB, 'OWNER');

  const productA = randomUUID();
  await admin().execute(sql`
    INSERT INTO products (id, tenant_id, sku, name, wine_type, price_cents, currency, stock_status, status)
    VALUES (${productA}, ${tenantA}, 'IDOR-1', 'Barolo', 'red', 4500, 'EUR', 'IN_STOCK', 'ACTIVE')
  `);

  const [domain] = [
    ...(await admin().execute(sql`
      INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status, verification_token)
      VALUES (${tenantA}, 'https://www.cantina-a.example', 'cantina-a.example', 'PENDING', 'nonce-a')
      RETURNING id
    `)),
  ] as { id: string }[];

  const [invitation] = [
    ...(await admin().execute(sql`
      INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
      VALUES (${tenantA}, 'guest@cantina-a.example', 'EDITOR', ${randomUUID()}, ${ownerA}, now() + interval '7 days')
      RETURNING id
    `)),
  ] as { id: string }[];

  /*
   * **The sharpest case in the matrix.** B is the holder A's claim was served
   * on, so the claim is visible to B under RLS — the policy's holder half
   * admits it, for P4-18b's withdrawal. The claimant's route must still answer
   * B exactly as it answers an id that never existed.
   */
  const [claim] = [
    ...(await admin().execute(sql`
      INSERT INTO domain_claims (
        tenant_id, incumbent_tenant_id, origin, registrable_domain, status, transfer_at
      )
      VALUES (
        ${tenantA}, ${tenantB}, 'https://www.cantina-b.example', 'cantina-b.example',
        'NOTICE', now() + interval '72 hours'
      )
      RETURNING id
    `)),
  ] as { id: string }[];

  /* Withdrawing is the holder's act. The claimant made the claim and can see
   * it, and still must be answered exactly as for an id that never existed. */
  const [served] = [
    ...(await admin().execute(sql`
      INSERT INTO domain_claims (
        tenant_id, incumbent_tenant_id, origin, registrable_domain, status, transfer_at
      )
      VALUES (
        ${tenantB}, ${tenantA}, 'https://www.cantina-a.example', 'cantina-a.example',
        'NOTICE', now() + interval '72 hours'
      )
      RETURNING id
    `)),
  ] as { id: string }[];

  seeded = {
    tenantA,
    tenantB,
    ownerA,
    ownerB,
    editorA,
    productA,
    domainA: domain?.id ?? '',
    invitationA: invitation?.id ?? '',
    claimA: claim?.id ?? '',
    servedA: served?.id ?? '',
  };
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

/** The app as one user sees it: a fresh second factor, real memberships, real ports. */
const appAs = (userId: string) =>
  createApp({
    auth: signedIn(userId),
    readMemberships: readMembershipsForUser,
    members: createMembersPort({
      sendEmail: () => Promise.resolve({ outcome: 'sent' } as never),
      acceptUrlBase: 'https://app.example/invito',
    }),
    products: createProductsPort(),
    keys: createKeysPort(),
    domains: createDomainsPort({
      environment: 'development',
      /* No network: a record nobody published. */
      newResolver: () => () => Promise.resolve([]),
    }),
  });

interface Case {
  readonly path: (ids: Seeded) => string;
  readonly missing: string;
  readonly body?: unknown;
}

/**
 * Every id-taking route, in an order that keeps A's own re-run valid: a
 * resource is edited, reindexed or verified before it is deleted.
 */
const MATRIX: ReadonlyMap<string, Case> = new Map<string, Case>([
  [
    'PATCH /v1/dashboard/products/:id',
    {
      path: (ids) => `/products/${ids.productA}`,
      missing: randomUUID(),
      body: { priceCents: 4700 },
    },
  ],
  [
    'POST /v1/dashboard/products/:id/reindex',
    { path: (ids) => `/products/${ids.productA}/reindex`, missing: randomUUID() },
  ],
  [
    'DELETE /v1/dashboard/products/:id',
    { path: (ids) => `/products/${ids.productA}`, missing: randomUUID() },
  ],
  [
    'PATCH /v1/dashboard/members/:userId',
    { path: (ids) => `/members/${ids.editorA}`, missing: 'user_nobody', body: { role: 'EDITOR' } },
  ],
  [
    'DELETE /v1/dashboard/members/:userId',
    { path: (ids) => `/members/${ids.editorA}`, missing: 'user_nobody' },
  ],
  [
    'POST /v1/dashboard/domains/:id/verify',
    {
      path: (ids) => `/domains/${ids.domainA}/verify`,
      missing: randomUUID(),
      body: { method: 'dns' },
    },
  ],
  [
    'DELETE /v1/dashboard/domains/:id',
    { path: (ids) => `/domains/${ids.domainA}`, missing: randomUUID() },
  ],
  [
    'POST /v1/dashboard/domains/claims/:id/verify',
    { path: (ids) => `/domains/claims/${ids.claimA}/verify`, missing: randomUUID() },
  ],
  [
    'POST /v1/dashboard/domains/claims/:id/withdraw',
    { path: (ids) => `/domains/claims/${ids.servedA}/withdraw`, missing: randomUUID() },
  ],
  [
    'DELETE /v1/dashboard/members/invitations/:id',
    { path: (ids) => `/members/invitations/${ids.invitationA}`, missing: randomUUID() },
  ],
]);

const call = async (
  userId: string,
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> => {
  const response = await appAs(userId).request(`/v1/dashboard${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = (await response.json()) as { error?: { requestId?: string } };

  /* The one field allowed to differ: every response carries its own. */
  if (parsed.error !== undefined) delete parsed.error.requestId;

  return { status: response.status, body: parsed };
};

describe('the matrix', () => {
  it('covers every dashboard route that takes an id, so a new one cannot skip it', () => {
    const idRoutes = [...DASHBOARD_ROUTES.keys()].filter((key) => key.includes('/:'));

    expect(idRoutes.length).toBeGreaterThan(0);
    expect([...MATRIX.keys()].sort()).toEqual(idRoutes.sort());
  });

  it.each([...MATRIX])(
    '%s answers 404 to another winery, exactly as for no such id',
    async (key, test) => {
      const method = key.split(' ')[0] ?? 'GET';
      const theirs = await call(seeded.ownerB, method, test.path(seeded), test.body);
      const missingPath = test.path({
        ...seeded,
        productA: test.missing,
        editorA: test.missing,
        domainA: test.missing,
        invitationA: test.missing,
        claimA: test.missing,
        servedA: test.missing,
      });
      const nobodys = await call(seeded.ownerB, method, missingPath, test.body);

      expect(theirs.status, key).toBe(404);
      expect(theirs.body, key).toEqual(nobodys.body);

      /* And the id was real, and the request well-formed: its own winery is served. */
      const own = await call(seeded.ownerA, method, test.path(seeded), test.body);

      expect(own.status, `${key} as its own winery`).not.toBe(404);
      expect(own.status, `${key} as its own winery`).toBeLessThan(500);
    },
  );
});
