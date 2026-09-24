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

/** The four routes, and which file answers each. */
const ROUTES: Readonly<Record<string, string>> = {
  '/': 'storefront.html',
  '/generic': 'generic.html',
  '/hostile': 'hostile.html',
  '/hostile.css': 'hostile.css',
};

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

    /* What the cart was told, for a test that cannot read the shop's memory. */
    if (url.pathname === '/__calls') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(calls));

      return;
    }

    /*
     * The real bundle, from the host page's own origin. A script's origin does
     * not enter into CORS — the *document's* does — so this is faithful and
     * saves standing up a third server to play the CDN.
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

    const text = await readFile(new URL(page, PAGES), 'utf8');

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

/** Where the built bundle is, from a package that needs to serve it. */
export const bundleDirectory = (): string =>
  fileURLToPath(new URL('../../../apps/widget/dist/bundle', import.meta.url));
