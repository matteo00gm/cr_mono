import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { Readable } from 'node:stream';

import { sql } from 'drizzle-orm';

import { startTestDatabase, type TestDatabase } from './db-harness.js';
import { makeProduct, makeTenant } from './factories.js';

/**
 * The API, on a port a browser can reach (P3-18, §6.3).
 *
 * **Everything a browser enforces needs a browser to prove.** P2-09 asserts the
 * headers we send; nothing in a unit test can assert that Chrome acts on them,
 * and the whole anti-sharing design rests on it doing so. That needs the real
 * middleware chain, the real database and the real key resolution, answering
 * over HTTP on an origin a page can be loaded from.
 *
 * **The model is the one thing that is scripted.** P1-47 forbids paid provider
 * calls without agreed spend, and the row's assertions are about CORS, the
 * session mint, the stream arriving and the cart — not about model quality. So
 * `chat` streams a fixed reply, and everything under it is real.
 */

/** Where the API answers. The host pages are on 4001 and 4002. */
export const API_PORT = 4000;

/** What the seeded storefront pastes into its script tag. */
export const WIDGET_KEY = 'pk_test_e2e_verified';

/** The wine the scripted reply recommends, so a card and a cart line are assertable. */
export const SEEDED_PRODUCT = {
  sku: 'E2E-BAROLO',
  name: 'Barolo Bussia',
  variantId: '45123456789',
} as const;

export interface E2eApi {
  readonly origin: string;
  readonly tenantId: string;
  readonly productId: string;
  readonly database: TestDatabase;
  /** Drops the verified domain, so the next request from `:4001` is refused (§5.7). */
  readonly unverifyDomain: () => Promise<void>;
  /** Puts it back. The suite is serial and shares one database, so state has to be restorable. */
  readonly reverifyDomain: () => Promise<void>;
  /** Every `security_events` row of a kind, for the assertions P3-18 makes server-side. */
  readonly securityEvents: () => Promise<{ type: string; origin: string | null }[]>;
  readonly close: () => Promise<void>;
}

/** The two origins the suite loads pages from. Only the first is verified. */
export const VERIFIED_ORIGIN = 'http://localhost:4001';
export const UNVERIFIED_ORIGIN = 'http://localhost:4002';

/**
 * A Hono app, over Node's `http`.
 *
 * Written out rather than taken from `@hono/node-server`, because it is fifteen
 * lines and a dependency added for a test harness is a dependency in the
 * lockfile forever. `app.fetch` is the whole interface Hono exposes.
 */
const bridge = (fetchHandler: (request: Request) => Promise<Response> | Response): Server =>
  createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const url = `http://localhost:${String(API_PORT)}${incoming.url ?? '/'}`;
    const headers = new Headers();

    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(name, value);
      else if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    }

    const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';

    /*
     * `duplex: 'half'` is required by Node whenever a `Request` carries a
     * stream, and `RequestInit` in the DOM lib does not name it — hence the
     * widened literal rather than a cast on the body.
     */
    const init: RequestInit & { duplex?: 'half' } = {
      method: incoming.method ?? 'GET',
      headers,
      ...(hasBody ? { body: Readable.toWeb(incoming), duplex: 'half' as const } : {}),
    };

    const request = new Request(url, init);

    void (async () => {
      const response = await fetchHandler(request);

      outgoing.writeHead(response.status, Object.fromEntries(response.headers));

      if (response.body === null) {
        outgoing.end();

        return;
      }

      /*
       * Piped rather than buffered, because the chat route is the one thing here
       * whose whole point is arriving in pieces — a harness that collected the
       * body first would make a streamed answer and a slow one identical, which
       * is the failure P2-29's headers exist to prevent.
       */
      for await (const chunk of response.body) outgoing.write(chunk);

      outgoing.end();
    })().catch(() => {
      outgoing.writeHead(500);
      outgoing.end();
    });
  });

export interface E2eApiOptions {
  /** Builds the Hono app from the wiring this harness produced. */
  readonly createApp: (dependencies: unknown) => { fetch: (request: Request) => Promise<Response> };
  /** The widget dependencies, assembled by the caller so this package imports no app code. */
  readonly dependenciesFor: (seed: E2eSeed) => unknown;
}

export interface E2eSeed {
  readonly tenantId: string;
  readonly productId: string;
  readonly database: TestDatabase;
}

/**
 * Brings up Postgres, seeds one winery, and serves the API.
 *
 * **Two tenants would be better and one is what this needs.** The isolation
 * story is `db-harness`'s and is tested there; what this proves is a browser
 * refusing a request, and a second tenant would be scenery.
 */
export const startE2eApi = async ({
  createApp,
  dependenciesFor,
}: E2eApiOptions): Promise<E2eApi> => {
  const database = await startTestDatabase();

  /*
   * **`app_rw`, the role the application runs as** — subject to RLS, exactly as
   * a deployment is. The scoped helpers read `DATABASE_URL` the same way the
   * Lambda does, so a harness that handed out the superuser would make every
   * policy in the schema vacuous and the suite would stay green proving nothing.
   */
  process.env.DATABASE_URL = database.roleUrl('app_rw');

  const tenant = makeTenant({ status: 'ACTIVE', locale: 'it' });
  const tenantId = randomUUID();
  const productId = randomUUID();

  const admin = database.adminDb;

  await admin.execute(sql`
    INSERT INTO tenants (id, name, slug, status, plan, locale)
    VALUES (${tenantId}, ${tenant.name}, ${tenant.slug}, 'ACTIVE', ${tenant.plan}, 'it')
  `);

  /* The origin the storefront is served from, and the only verified one. */
  await admin.execute(sql`
    INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status, verified_at)
    VALUES (${tenantId}, ${VERIFIED_ORIGIN}, 'localhost', 'VERIFIED', now())
  `);

  /*
   * `:4002` exists as a *pending* domain rather than not at all. A seller who
   * added a domain and never proved it is the realistic shape of this refusal,
   * and it exercises the same branch as an unknown origin without pretending
   * the row is missing.
   */
  await admin.execute(sql`
    INSERT INTO tenant_domains (tenant_id, origin, registrable_domain, status)
    VALUES (${tenantId}, ${UNVERIFIED_ORIGIN}, 'localhost', 'PENDING')
  `);

  await admin.execute(sql`
    INSERT INTO widget_keys (tenant_id, public_key, secret_key_hash, secret_key_prefix, secret_key_last4)
    VALUES (${tenantId}, ${WIDGET_KEY}, 'not-a-real-hash', 'sk_test_', 'e2e0')
  `);

  const product = makeProduct(0, {
    sku: SEEDED_PRODUCT.sku,
    name: SEEDED_PRODUCT.name,
    externalVariantId: SEEDED_PRODUCT.variantId,
  });

  await admin.execute(sql`
    INSERT INTO products (
      id, tenant_id, sku, external_variant_id, name, wine_type,
      price_cents, currency, stock_status, status
    )
    VALUES (
      ${productId}, ${tenantId}, ${product.sku}, ${SEEDED_PRODUCT.variantId},
      ${product.name}, ${product.wineType}, ${product.priceCents}, ${product.currency},
      'IN_STOCK', 'ACTIVE'
    )
  `);

  const app = createApp(dependenciesFor({ tenantId, productId, database }));
  const server = bridge((request) => app.fetch(request));

  await new Promise<void>((resolve) => {
    server.listen(API_PORT, '127.0.0.1', resolve);
  });

  return {
    origin: `http://localhost:${String(API_PORT)}`,
    tenantId,
    productId,
    database,

    unverifyDomain: async () => {
      /*
       * §5.7's immediate effect: resolution is uncached, so the *next* request
       * from a storefront whose domain was just removed is refused. Nothing to
       * invalidate, which is the property the suite reads back.
       */
      await admin.execute(sql`
        UPDATE tenant_domains SET status = 'PENDING', verified_at = NULL
        WHERE tenant_id = ${tenantId} AND origin = ${VERIFIED_ORIGIN}
      `);
    },

    reverifyDomain: async () => {
      await admin.execute(sql`
        UPDATE tenant_domains SET status = 'VERIFIED', verified_at = now()
        WHERE tenant_id = ${tenantId} AND origin = ${VERIFIED_ORIGIN}
      `);
    },

    securityEvents: async () => {
      const rows = await admin.execute(sql`
        SELECT type, origin FROM security_events WHERE tenant_id = ${tenantId} OR tenant_id IS NULL
        ORDER BY created_at
      `);

      return [...rows] as { type: string; origin: string | null }[];
    },

    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await database.close();
    },
  };
};
