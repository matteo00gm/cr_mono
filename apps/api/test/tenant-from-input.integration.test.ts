import process from 'node:process';
import { ACTIVE_TENANT_HEADER, createAuth } from '@catalogorosso/core';
import { readMembershipsForUser } from '@catalogorosso/db';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { AUTH_PUBLIC_PATH, DASHBOARD_PREFIX } from '../src/routes.js';

/**
 * The behavioural half of P0-48 — the highest-value IDOR prevention here.
 *
 * The lint rule catches the next author; this catches the code. Neither is
 * sufficient: the rule keys on identifier names and can be sidestepped by a
 * constant named to hide the intent, and a test alone does nothing about the
 * handler somebody writes next week.
 *
 * **Asserted on returned data, not on a mock.** A real user, a real session, a
 * real `memberships` row, and two real tenants — so "the effective tenant is
 * still A" is a statement about what the database actually scoped to, not about
 * what a stub was asked for.
 */

let harness: TestDatabase | undefined;
let app: ReturnType<typeof createApp>;

/** The tenant the user belongs to. */
let mine = '';
/** A real, existing tenant the user has nothing to do with. */
let theirs = '';
let cookie = '';

const credentials = {
  name: 'Matteo',
  email: 'idor@example.test',
  password: 'a-perfectly-adequate-password',
};

const context = async (headers: Record<string, string> = {}): Promise<Response> =>
  await app.request(`${DASHBOARD_PREFIX}/context`, { headers: { cookie, ...headers } });

const tenantOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { tenantId?: unknown }).tenantId;

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');

  app = createApp({
    auth: createAuth({
      secret: 'idor-suite-secret-value-long-enough-to-be-plausible',
      baseUrl: 'http://localhost',
      basePath: AUTH_PUBLIC_PATH,
      sendResetPassword: () => Promise.resolve(),
    }),
    readMemberships: readMembershipsForUser,
  });

  const signUp = await app.request(`${AUTH_PUBLIC_PATH}/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  cookie = signUp.headers.get('set-cookie') ?? '';

  const [userRow] = [
    ...(await harness.adminDb.execute<{ id: string }>(
      sql`select id from auth_users where email = ${credentials.email}`,
    )),
  ];
  const userId = userRow?.id ?? '';

  /*
   * Two tenants, and the second is real. A test where the "other" tenant does
   * not exist would pass against an implementation that trusted the request and
   * simply found nothing — the failure has to be indistinguishable from success
   * for the assertion to mean anything.
   */
  const insertTenant = async (slug: string): Promise<string> => {
    const id = crypto.randomUUID();
    await harness?.adminDb.execute(
      sql`insert into tenants (id, name, slug) values (${id}::uuid, ${slug}, ${slug})`,
    );
    return id;
  };

  mine = await insertTenant('cantina-mia');
  theirs = await insertTenant('cantina-altrui');

  await harness.adminDb.execute(
    sql`insert into memberships (tenant_id, user_id, role) values (${mine}::uuid, ${userId}, 'EDITOR')`,
  );
  /*
   * Somebody else's winery, with a real member who is not us. Without this the
   * "other" tenant would be empty, and an implementation that trusted the
   * request would return nothing rather than the wrong thing — passing for the
   * wrong reason.
   */
  const stranger = `user_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
  await harness.adminDb.execute(
    sql`insert into auth_users (id, name, email)
        values (${stranger}, 'Altri', ${`${stranger}@example.test`})`,
  );
  await harness.adminDb.execute(
    sql`insert into memberships (tenant_id, user_id, role)
        values (${theirs}::uuid, ${stranger}, 'OWNER')`,
  );
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('the baseline', () => {
  it('resolves the tenant the caller actually belongs to', async () => {
    const response = await context();

    expect(response.status).toBe(200);
    expect(await tenantOf(response)).toBe(mine);
  });
});

describe('a tenant id smuggled in through the request', () => {
  it('is ignored in a query parameter', async () => {
    const response = await app.request(
      `${DASHBOARD_PREFIX}/context?tenantId=${theirs}&tenant_id=${theirs}`,
      { headers: { cookie } },
    );

    expect(await tenantOf(response)).toBe(mine);
  });

  it('is ignored in an X-Tenant-Id header', async () => {
    const response = await context({ 'x-tenant-id': theirs });

    expect(await tenantOf(response)).toBe(mine);
  });

  it('is ignored in the body', async () => {
    const response = await app.request(`${DASHBOARD_PREFIX}/context`, {
      method: 'GET',
      headers: { cookie, 'content-type': 'application/json' },
    });

    expect(await tenantOf(response)).toBe(mine);
  });

  it('is ignored when every channel is used at once', async () => {
    // Belt and braces: an implementation might read only one of them, and a
    // test that tried them one at a time would still pass against it.
    const response = await app.request(`${DASHBOARD_PREFIX}/context?tenantId=${theirs}`, {
      headers: {
        cookie,
        'x-tenant-id': theirs,
        'x-tenant': theirs,
        'tenant-id': theirs,
      },
    });

    expect(await tenantOf(response)).toBe(mine);
  });
});

describe('the one channel that is read', () => {
  it('honours the active-tenant header when the caller is a member', async () => {
    // Not a contradiction: this is a *selection among rows the database already
    // agrees exist*. With one membership, selecting it is a no-op.
    const response = await context({ [ACTIVE_TENANT_HEADER]: mine });

    expect(await tenantOf(response)).toBe(mine);
  });

  it('refuses it — with 404 — when the caller is not', async () => {
    /*
     * The re-validation the whole mechanism rests on, against a tenant that
     * genuinely exists and genuinely has members. 404 rather than 403, so the
     * answer carries no information about whether that winery is real (§3.5).
     */
    const response = await context({ [ACTIVE_TENANT_HEADER]: theirs });

    expect(response.status).toBe(404);
  });

  it('answers the same for a tenant that does not exist at all', async () => {
    // The pair that makes the previous assertion meaningful: a real winery the
    // caller may not use and a made-up one are indistinguishable.
    const real = await context({ [ACTIVE_TENANT_HEADER]: theirs });
    const invented = await context({
      [ACTIVE_TENANT_HEADER]: '99999999-9999-9999-9999-999999999999',
    });

    /*
     * Compared with the request id removed. That field is deliberately unique
     * per request (P0-55), so comparing raw bodies would fail for a reason that
     * has nothing to do with what is being asserted — and "make them identical"
     * would mean giving up the one handle a caller has on a log line.
     */
    const withoutRequestId = async (response: Response): Promise<string> => {
      const payload = (await response.json()) as { error: Record<string, unknown> };
      const rest = Object.fromEntries(
        Object.entries(payload.error).filter(([key]) => key !== 'requestId'),
      );
      return JSON.stringify(rest);
    };

    expect(invented.status).toBe(real.status);
    expect(await withoutRequestId(invented)).toBe(await withoutRequestId(real));
  });
});

describe('what the database actually scoped to', () => {
  it('sees only the caller’s own membership, with two tenants present', async () => {
    /*
     * The assertion behind all the others. `/me` lists memberships through
     * `withUser`, so this is RLS answering — not the API filtering. Both
     * tenants exist and both have members; exactly one row comes back.
     */
    const response = await app.request(`${DASHBOARD_PREFIX}/me`, { headers: { cookie } });
    const payload = (await response.json()) as { memberships: { tenantId: string }[] };

    expect(payload.memberships.map((m) => m.tenantId)).toEqual([mine]);
  });
});
