import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Storefronts, on origins that are not ours (P3-17, §6.3).
 *
 * **CORS can only be proven from a genuinely different origin.** P2-09 asserts
 * the headers we send; nothing in a unit test can assert that a browser acts on
 * them, and the whole anti-sharing design rests on it doing so. That needs a
 * page, served from a port the API has never heard of, loading the real bundle.
 *
 * **One page, two ports.** `:4001` is a verified domain in the seed and `:4002`
 * is not, and they are served from the same file — so the only difference
 * between a widget that works and one the browser blocks is the origin. Two
 * files would let them drift, and a drift here would look exactly like the
 * failure the suite exists to prove.
 *
 * **The fake Shopify surface belongs to the shop, not to us.** `/cart/add.js`
 * and `/cart.js` are served by this server, on the host page's own origin,
 * because that is where they live on a real storefront — a harness that served
 * them from the API would prove nothing about the request the widget actually
 * makes.
 */

/** Where the pages live. Verified in the seed; the suite depends on the pairing. */
export const VERIFIED_PORT = 4001;
export const UNVERIFIED_PORT = 4002;

export interface HostPageOptions {
  readonly port: number;
  /** The API origin the pasted snippet points at, written into `data-api`. */
  readonly api: string;
  /** The seller's public key, written into `data-key`. */
  readonly widgetKey: string;
  /** Where the built widget bundle is, served under `/widget/`. */
  readonly bundleDir: string;
}

/** One line the fake Shopify cart recorded, for a test to read back. */
export interface CartCall {
  readonly path: string;
  readonly body: unknown;
}

export interface HostPages {
  readonly origin: string;
  /** Every `/cart/add.js` the widget sent, in order. */
  readonly calls: () => readonly CartCall[];
  readonly reset: () => void;
  readonly close: () => Promise<void>;
}

const PAGES = new URL('../host-pages/', import.meta.url);

/** The routes, and which file answers each. */
const ROUTES: Readonly<Record<string, string>> = {
  '/': 'storefront.html',
  /* The same storefront, with a theme's own choices on the tag (P6-09). */
  '/themed': 'storefront.html',
  '/generic': 'generic.html',
  '/hostile': 'hostile.html',
  '/hostile.css': 'hostile.css',
  /* The same storefront, loading the widget from a CDN on an origin of its own (P3-01a). */
  '/cdn': 'storefront.html',
  '/cdn-without-cors': 'storefront.html',
};

/**
 * A stand-in for the CDN, on an origin that is neither the storefront's nor the
 * API's (P3-01a). Production serves the loader from our domain onto a seller's,
 * and a module script crossing origins is fetched with CORS — which a bundle
 * served from the storefront's own origin, as every other page here is, never
 * exercises.
 */
export const CDN_PORT = 4003;

/** The same CDN without `Access-Control-Allow-Origin`: what the distribution would be without its policy. */
export const CDN_WITHOUT_CORS_PORT = 4004;

const CDN_PAGES: Readonly<Record<string, number>> = {
  '/cdn': CDN_PORT,
  '/cdn-without-cors': CDN_WITHOUT_CORS_PORT,
};

const LOADER_TAG = 'src="/widget/loader.js"';

/** The storefront's tag, pointed at the CDN's `/v1/w.js` as `LOADER_SRC` points at production's. */
const fromCdn = (page: string, port: number): string =>
  page.replace(LOADER_TAG, `src="http://localhost:${String(port)}/v1/w.js"`);

/**
 * What a Shopify theme sets on every storefront, as a script of its own (P3-19).
 *
 * The plain storefront sets it inline; the hostile page cannot, because its
 * policy is `script-src 'self'` — so it loads this, which is how a real theme
 * on a strict policy gets its globals: from a script it allows. Without it the
 * hostile page is a shop with no cart, the widget rightly offers no button,
 * and the two pages cannot be compared pixel for pixel.
 */
const SHOPIFY_GLOBALS = `window.Shopify = { shop: 'cantina-rossi.myshopify.com', locale: 'it' };`;

/**
 * What a Shopify theme's settings add to the tag (P6-09): the storefront's own
 * corner and colour, as the theme extension writes them.
 *
 * **Added to the one storefront page rather than kept in a second file**, for
 * the reason both ports serve one file: two pages would drift, and a
 * difference between them would read as a difference the attributes made.
 */
export const THEMED = { position: 'bottom-left', color: '#1f6f4a' } as const;

const SNIPPET_API = 'data-api="__API__"';

const themed = (page: string): string =>
  page.replace(
    SNIPPET_API,
    `${SNIPPET_API} data-position="${THEMED.position}" data-color="${THEMED.color}"`,
  );

const TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  map: 'application/json; charset=utf-8',
};

const typeOf = (file: string): string =>
  TYPES[file.split('.').at(-1) ?? ''] ?? 'application/octet-stream';

const bodyOf = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(chunk as Buffer);

  return Buffer.concat(chunks).toString('utf8');
};

/**
 * Serves the host pages, and a Shopify cart that records what it was told.
 *
 * Returns once the port is actually listening, because a Playwright run that
 * navigates to a server still binding fails in a way that reads like a product
 * bug.
 */
export const startHostPages = async ({
  port,
  api,
  widgetKey,
  bundleDir,
}: HostPageOptions): Promise<HostPages> => {
  let calls: CartCall[] = [];

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> => {
    /*
     * **The fake Shopify cart.** It answers on the *host page's* origin, which
     * is the whole point: the widget must post a relative URL, and a widget
     * that built an absolute one would land here never.
     */
    if (url.pathname === '/cart/add.js') {
      const raw = await bodyOf(request);
      let parsed: unknown;

      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }

      calls.push({ path: url.pathname, body: parsed });

      /* `sold-out` is the variant a test uses to exercise Shopify's own 422. */
      if (raw.includes('sold-out')) {
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ description: 'Barolo Bussia è esaurito.' }));

        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: [] }));

      return;
    }

    if (url.pathname === '/cart.js') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ item_count: calls.length }));

      return;
    }

    if (url.pathname === '/shopify.js') {
      response.writeHead(200, { 'content-type': typeOf(url.pathname) });
      response.end(SHOPIFY_GLOBALS);

      return;
    }

    /* What the cart was told, for a test that cannot read the shop's memory. */
    if (url.pathname === '/__calls') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(calls));

      return;
    }

    /*
     * The real bundle, from the host page's own origin. Faithful for the API's
     * CORS, which is decided by the *document's* origin whatever the script's.
     * **Not faithful for the script itself**: a module script from another
     * origin is fetched with CORS too, which serving it from here never
     * exercises — the gap that let the widget go unpublished (P3-01a). The
     * `/cdn` pages and `startCdn` below are the production arrangement.
     */
    if (url.pathname.startsWith('/widget/')) {
      const name = url.pathname.slice('/widget/'.length);
      const file = await readFile(new URL(name, `file://${bundleDir.replaceAll('\\', '/')}/`));

      response.writeHead(200, { 'content-type': typeOf(name) });
      response.end(file);

      return;
    }

    const page = ROUTES[url.pathname];

    if (page === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');

      return;
    }

    const file = await readFile(new URL(page, PAGES), 'utf8');
    const cdn = CDN_PAGES[url.pathname];
    const text =
      url.pathname === '/themed' ? themed(file) : cdn === undefined ? file : fromCdn(file, cdn);

    response.writeHead(200, { 'content-type': typeOf(page) });
    /* The snippet a seller pastes, filled in with this run's key and API. */
    response.end(text.replaceAll('__WIDGET_KEY__', widgetKey).replaceAll('__API__', api));
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${String(port)}`);

    void handle(request, response, url).catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(error));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    origin: `http://localhost:${String(port)}`,
    calls: () => calls,
    reset: () => {
      calls = [];
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
};

export interface Cdn {
  readonly origin: string;
  /** Every path asked of it, in order. */
  readonly requested: () => readonly string[];
  readonly close: () => Promise<void>;
}

/**
 * The CDN's half of the widget's publication (P3-01a), served as
 * `infra/widget-assets.ts` lays it out: the loader at `/v1/w.js`, and the rest
 * of the build beside it under its own name — so the loader's relative
 * `import()` of `./widget-<hash>.js` lands here too, crossing origins again.
 */
export const startCdn = async ({
  port,
  bundleDir,
  cors,
}: {
  readonly port: number;
  readonly bundleDir: string;
  /** Whether to say every origin may read these, as the distribution's policy does. */
  readonly cors: boolean;
}): Promise<Cdn> => {
  const requested: string[] = [];

  const server: Server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', `http://localhost:${String(port)}`);

    requested.push(pathname);

    const name = pathname === '/v1/w.js' ? 'loader.js' : pathname.slice('/v1/'.length);

    if (!pathname.startsWith('/v1/') || !/^[A-Za-z0-9._-]+$/u.test(name)) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');

      return;
    }

    void readFile(new URL(name, `file://${bundleDir.replaceAll('\\', '/')}/`)).then(
      (file) => {
        response.writeHead(200, {
          'content-type': typeOf(name),
          ...(cors ? { 'access-control-allow-origin': '*' } : {}),
        });
        response.end(file);
      },
      () => {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
      },
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    origin: `http://localhost:${String(port)}`,
    requested: () => requested,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
};

/** Where the built bundle is, from a package that needs to serve it. */
export const bundleDirectory = (): string =>
  fileURLToPath(new URL('../../../apps/widget/dist/bundle', import.meta.url));
