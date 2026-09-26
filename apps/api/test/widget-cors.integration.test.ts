import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { resolveTenantByKeyAndOrigin } from '@catalogorosso/db';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppEnv } from '../src/env.js';
import { widgetCors, type RejectedWidgetRequest } from '../src/middleware/cors.js';
import { errorHandler } from '../src/middleware/error.js';
import { requestContext } from '../src/middleware/logger.js';

/**
 * Widget CORS against real Postgres (P2-09).
 *
 * The request-level suite in `widget-cors.test.ts` drives the middleware with a
 * resolver the test controls. This one puts the real accessor behind it — the
 * read-only widget scope and migration 0042's policies — because two of the
 * row's claims are about the database rather than about the middleware:
 *
 * - **A bypass string is refused all the way down**, not merely by a fake that
 *   only knows one origin.
 * - **A domain removed mid-test is refused on the very next request** (§5.7).
 *   Nothing caches the allowlist, and this is where that is proven rather than
 *   assumed.
 *
 * The row also asks for a `security_events` row per refusal. The writer is
 * P2-16's; until it lands, what is asserted is the report the middleware hands
 * it.
 */

let harness: TestDatabase | undefined;

/** Assembled at runtime, never written as a literal (P0-56). */
const publicKey = (): string => ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

interface SeededTenant {
  readonly tenantId: string;
  readonly key: string;
  readonly origin: string;
}

const seedTenant = async (slug: string): Promise<SeededTenant> => {
  if (harness === undefined) throw new Error('harness not started');

  const tenantId = randomUUID();
  const key = publicKey();
  const origin = `https://${slug}.example`;

  await harness.adminDb.execute(sql`
    insert into tenants (id, name, slug, status, plan, locale)
    values (${tenantId}::uuid, ${slug}, ${slug}, 'ACTIVE', 'CANTINA', 'it')
  `);
  await harness.adminDb.execute(sql`
    insert into widget_keys (tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4)
    values (${tenantId}::uuid, ${key}, md5(random()::text), 'sk_test_', 'abcd')
  `);
  await harness.adminDb.execute(sql`
    insert into tenant_domains (tenant_id, origin, registrable_domain, status)
    values (${tenantId}::uuid, ${origin}, ${`${slug}.example`}, 'VERIFIED')
  `);

  return { tenantId, key, origin };
};

let rossi: SeededTenant;
let verdi: SeededTenant;
const reported: RejectedWidgetRequest[] = [];

const app = () => {
  const widget = new Hono<AppEnv>();

  widget.use('*', requestContext());
  widget.onError(errorHandler);
  widget.on(
    ['GET', 'OPTIONS'],
    '/config',
    widgetCors({
      resolve: (key, origin) => resolveTenantByKeyAndOrigin(key, origin),
      onRejected: (event) => {
        reported.push(event);
        return Promise.resolve();
      },
    }),
    (c) => c.json({ tenantId: c.get('widgetTenant').tenantId }),
  );

  return widget;
};

const get = (key: string, origin: string, method = 'GET') =>
  app().request(`/config?key=${encodeURIComponent(key)}`, { method, headers: { origin } });

const corsHeadersOf = (response: Response) =>
  [...response.headers.keys()].filter((name) => name.startsWith('access-control-'));

beforeAll(async () => {
  harness = await startTestDatabase();

  // The accessor uses the package's memoised client, which reads this once.
  process.env.DATABASE_URL = harness.roleUrl('app_rw');

  rossi = await seedTenant('cantina-rossi');
  verdi = await seedTenant('cantina-verdi');
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('through the real accessor', () => {
  it('allows a verified pair, and hands on the tenant the database resolved', async () => {
    const response = await get(rossi.key, rossi.origin);

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(rossi.origin);
    expect(response.headers.get('vary')).toContain('Origin');
    expect(await response.json()).toEqual({ tenantId: rossi.tenantId });
  });

  it('answers the preflight for a verified pair the same way', async () => {
    const response = await get(rossi.key, rossi.origin, 'OPTIONS');

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(rossi.origin);
  });

  it("refuses one tenant's origin presented with another tenant's key", async () => {
    // Both halves are real and verified — for different wineries.
    reported.length = 0;

    const response = await get(verdi.key, rossi.origin);

    expect(response.status).toBe(403);
    expect(corsHeadersOf(response)).toEqual([]);
    expect(response.headers.get('vary')).toContain('Origin');
    expect(reported).toEqual([
      {
        type: 'UNAUTHORIZED_ORIGIN',
        tenantId: verdi.tenantId,
        origin: rossi.origin,
        publicKey: verdi.key,
      },
    ]);
  });

  it.each([
    'https://evil-cantina-rossi.example',
    'https://cantina-rossi.example.attacker.io',
    'https://CANTINA-ROSSI.EXAMPLE.attacker.io',
    'https://cantína-rossi.example',
    'https://xn--cantina-rossi.example',
    'https://cantina-rossi.example%00.evil.io',
    'https://cantina-rossi.example%2eevil.io',
    'https://cantina-rossi.example@evil.io',
    'https://evil.io#@cantina-rossi.example',
    'https://evil.io?.cantina-rossi.example',
    'https://cantina-rossi.example:443.evil.io',
    'https://cantina-rossi.example/.evil.io',
    'https://*.cantina-rossi.example',
    'http://cantina-rossi.example',
    'https://cantina-rossi.example:8443',
    'https://ccantina-rossi.example',
    'null',
  ])('refuses %j with a bare 403, even with the real key', async (origin) => {
    const response = await get(rossi.key, origin);

    expect(response.status).toBe(403);
    expect(corsHeadersOf(response)).toEqual([]);
  });

  it('gives a trailing-dot Origin an echo that is not its own, so the browser refuses it', async () => {
    /*
     * The one spelling that normalises onto the verified origin without being
     * it. The server answers for the verified name; a browser compares the
     * echo with its own origin, finds `https://cantina-rossi.example` is not
     * `https://cantina-rossi.example.`, and withholds the response.
     */
    const dotted = `${rossi.origin}.`;
    const response = await get(rossi.key, dotted);

    expect(response.headers.get('access-control-allow-origin')).toBe(rossi.origin);
    expect(response.headers.get('access-control-allow-origin')).not.toBe(dotted);
  });
});

describe('no cache between the allowlist and the answer (§5.7)', () => {
  it('refuses the very next request once a domain is removed', async () => {
    const bianchi = await seedTenant('cantina-bianchi');

    expect((await get(bianchi.key, bianchi.origin)).status).toBe(200);

    await harness?.adminDb.execute(
      sql`delete from tenant_domains where origin = ${bianchi.origin}`,
    );

    const after = await get(bianchi.key, bianchi.origin);

    expect(after.status).toBe(403);
    expect(corsHeadersOf(after)).toEqual([]);
  });

  it('refuses the very next request once a key is revoked past its grace window', async () => {
    const neri = await seedTenant('cantina-neri');

    expect((await get(neri.key, neri.origin)).status).toBe(200);

    await harness?.adminDb.execute(sql`
      update widget_keys
      set revoked_at = now() - interval '2 days', grace_until = now() - interval '1 day'
      where public_key = ${neri.key}
    `);

    expect((await get(neri.key, neri.origin)).status).toBe(403);
  });
});
