import type { WidgetConfigResponse } from '@catalogorosso/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adoptStyles } from '../src/adopt-styles.js';
import type { CartPort } from '../src/cart/port.js';
import type { Asker } from '../src/components/Chat.js';
import { en } from '../src/i18n/en.js';
import { it as COPY } from '../src/i18n/it.js';
import { mountPanel } from '../src/panel.js';

/**
 * The panel, and what it puts inside itself (P3-06).
 *
 * **The composition is the point.** `lazy.test.ts` covers when the panel is
 * built and `chat.test.tsx` covers what the chat does; what only this file can
 * say is that the panel actually mounts one, and that closing the panel does
 * not throw the conversation away — which §1.3 requires and an unmount-on-close
 * would quietly break with every component test still passing.
 */

const config: WidgetConfigResponse = {
  status: 'ACTIVE',
  locale: 'it',
  theme: { primaryColor: '#7b1e3c', position: 'bottom-right', avatarUrl: null },
  welcomeMessage: 'Posso consigliarle un vino?',
  cartUrl: 'https://cantina-rossi.example/cart',
  quotaState: 'ok',
};

const API = 'https://api.example';
const KEY = 'pk_test_abc';

let shadow: ShadowRoot;
let launcher: HTMLButtonElement;

const silent: Asker = () => ({
  // eslint-disable-next-line @typescript-eslint/require-await -- an async iterable is the contract
  async *[Symbol.asyncIterator]() {
    yield { type: 'done' } as const;
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  document.body.replaceChildren();

  const host = document.createElement('sommelier-widget');

  shadow = host.attachShadow({ mode: 'open' });
  launcher = document.createElement('button');
  launcher.type = 'button';
  shadow.append(launcher);
  document.body.append(host);
});

const mount = (ask: Asker = silent) =>
  mountPanel({ shadow, launcher, adoptStyles, config, api: API, key: KEY, ask });

describe('what is inside the panel', () => {
  it('mounts the chat', () => {
    const panel = mount();

    expect(panel.body.querySelector('.chat')).not.toBeNull();
    expect(panel.body.querySelector('.composer-input')).not.toBeNull();
  });

  it('gives the streaming answer a live region', () => {
    // §1.7. Asserted here as well as in the component, because this is the tree
    // that actually reaches a visitor.
    const region = mount().body.querySelector('[role="log"]');

    expect(region?.getAttribute('aria-live')).toBe('polite');
  });

  it('labels the composer, so it is not an unnamed box in a dialog', () => {
    const label = mount().body.querySelector('label');

    /* jsdom reports `en-US`, so this is the English catalogue by design. */
    expect(label?.textContent).toBe(en.composerLabel);
  });

  it('mounts without a request of any kind, not even a session', () => {
    /*
     * The panel is built on the first click. A visitor who opens it, reads the
     * welcome message and closes it again has cost one bundle and nothing else
     * — no session mint, no question, no model call. Mounted here *without* an
     * injected asker, so the real composition is what is being measured.
     */
    const fetch_ = vi.fn<typeof globalThis.fetch>();

    vi.stubGlobal('fetch', fetch_);

    mountPanel({ shadow, launcher, adoptStyles, config, api: API, key: KEY });

    expect(fetch_).not.toHaveBeenCalled();
  });

  it('asks nothing until a visitor does', () => {
    /*
     * Mounting must cost no request — not a session, not a question. The panel
     * is built on the first click, and a visitor who opens it and reads the
     * welcome message has spent nothing.
     */
    const ask = vi.fn<Asker>(silent);

    mount(ask);

    expect(ask).not.toHaveBeenCalled();
  });
});

describe('which language it speaks', () => {
  /*
   * §1.3's copy is Italian first, and the shop's own setting is where it comes
   * from. A visitor whose browser has been asking for English all day is the
   * case the tenant default gets wrong (P3-14).
   */
  const speaking = (language: string) => {
    /* A stand-in rather than a spread: `navigator` is a class instance and
     * spreading it would drop its prototype along with everything on it. */
    vi.stubGlobal('navigator', { language });

    return mount().body;
  };

  it('follows the visitor browser when we have the catalogue', () => {
    expect(speaking('en-GB').querySelector('label')?.textContent).toBe(en.composerLabel);
  });

  it('falls back to the winery setting for a language we do not have', () => {
    expect(speaking('de-DE').querySelector('label')?.textContent).toBe(COPY.composerLabel);
  });

  it('reads a region-tagged Italian browser as Italian', () => {
    expect(speaking('it-CH').querySelector('label')?.textContent).toBe(COPY.composerLabel);
  });
});

describe('a winery that is not serving', () => {
  it('says so, and takes no questions', () => {
    /*
     * P3-03 normally stops long before here. This is the seller who lapses
     * *mid-session*, with the chat already open on a visitor's screen.
     */
    const panel = mountPanel({
      shadow,
      launcher,
      adoptStyles,
      config: { ...config, status: 'DISABLED' },
      api: API,
      key: KEY,
      ask: silent,
    });

    expect(panel.body.querySelector('.notice-text')?.textContent).toBe(en.disabled);
    expect(panel.body.querySelector<HTMLInputElement>('.composer-input')?.disabled).toBe(true);
    expect(panel.body.querySelector('.notice-retry')).toBeNull();
  });
});

describe('closing', () => {
  it('hides the panel without unmounting the conversation', () => {
    /*
     * §1.3: "conversation preserved in memory". Unmounting on close would abort
     * the answer and lose the turns, and every component test would still pass.
     */
    const panel = mount();

    panel.open();
    panel.close();

    expect(panel.isOpen()).toBe(false);
    expect(panel.body.querySelector('.chat')).not.toBeNull();
  });

  it('moves aria-expanded with the panel', () => {
    const panel = mount();

    panel.open();

    expect(launcher.getAttribute('aria-expanded')).toBe('true');

    panel.close();

    expect(launcher.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the storefront own cart', () => {
  const port = (count: number | undefined): CartPort => ({
    canAdd: true,
    needsVariantId: false,
    add: () => Promise.resolve(),
    count: () => Promise.resolve(count),
  });

  const withCart = (cartPort: CartPort | undefined) =>
    mountPanel({
      shadow,
      launcher,
      adoptStyles,
      config,
      api: API,
      key: KEY,
      ask: silent,
      ...(cartPort === undefined ? {} : { cartPort }),
      navigate: () => undefined,
    });

  it('shows a cart button when the storefront has a cart', () => {
    expect(withCart(port(0)).body.querySelector('.cart-button')).not.toBeNull();
  });

  it('resolves the page own cart when nobody injected one', () => {
    /*
     * jsdom has neither `window.Shopify` nor `__sommelierCart`, so this is the
     * `none` branch reaching the panel: a button that leads to the shop's cart,
     * and cards that degrade to "Vedi prodotto" (§1.6).
     */
    const panel = withCart(undefined);

    expect(panel.body.querySelector('.cart-button')).not.toBeNull();
    expect(panel.body.querySelector('.card-add')).toBeNull();
  });

  it('points the button at the winery configured cart', async () => {
    const navigate = vi.fn();
    const panel = mountPanel({
      shadow,
      launcher,
      adoptStyles,
      config: { ...config, cartUrl: 'https://cantina-rossi.example/carrello' },
      api: API,
      key: KEY,
      ask: silent,
      cartPort: port(0),
      navigate,
    });

    panel.body.querySelector<HTMLButtonElement>('.cart-button')?.click();

    await Promise.resolve();

    expect(navigate).toHaveBeenCalledOnce();
  });
});

/** One macrotask, which flushes Preact's microtask-batched renders. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('a token the server has stopped accepting', () => {
  /*
   * **The reactive half of P3-21, through the real asker.** `token()` refreshes
   * inside a minute of expiry, which stops most 401s happening at all; this is
   * the one that got through anyway — a revoked token, a clock apart, a mint
   * that raced an expiry.
   *
   * Asserted here rather than in `chat.test.tsx` because the retry lives in the
   * composition: the component is handed an asker and never sees a token.
   */
  const jwt = (secondsFromNow: number): string => {
    const claims = { sid: 'sess', exp: Math.floor(Date.now() / 1000) + secondsFromNow };
    const payload = globalThis
      .btoa(JSON.stringify(claims))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');

    return ['header', payload, 'signature'].join('.');
  };

  const minted = (token: string): Response =>
    new Response(JSON.stringify({ token, expiresAt: '2026-09-25T12:00:00.000Z' }), {
      headers: { 'content-type': 'application/json' },
    });

  const stream = (text: string): Response =>
    new Response(
      [
        `event: text${String.fromCharCode(10)}data: ${JSON.stringify({ type: 'text', delta: text })}`,
        '',
        `event: done${String.fromCharCode(10)}data: {}`,
        '',
        '',
      ].join(String.fromCharCode(10)),
      { headers: { 'content-type': 'text/event-stream' } },
    );

  const refused = (status: number): Response =>
    new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  /** Routes by path, so the order of session and chat calls is not assumed. */
  const routing = (chat: readonly Response[]) => {
    const tokens = [jwt(900), jwt(900)];
    let mints = 0;
    let asks = 0;

    const fetch_ = vi.fn<typeof globalThis.fetch>((input) => {
      /* Always a string here; `RequestInfo` is wider than what we ever pass. */
      const url = input as string;

      if (url.includes('/session')) {
        mints += 1;

        return Promise.resolve(minted(tokens[mints - 1] ?? jwt(900)));
      }

      asks += 1;

      return Promise.resolve(chat[asks - 1] ?? stream('fallback'));
    });

    return { fetch_, mints: () => mints, asks: () => asks };
  };

  const answer = async (chat: readonly Response[]) => {
    const route = routing(chat);

    vi.stubGlobal('fetch', route.fetch_);

    const panel = mountPanel({ shadow, launcher, adoptStyles, config, api: API, key: KEY });
    const input = panel.body.querySelector('.composer-input');
    const form = panel.body.querySelector('form');

    (input as HTMLInputElement).value = 'Che vino?';
    input?.dispatchEvent(new Event('input', { bubbles: true }));

    /*
     * A tick between typing and submitting, because Preact's state update is a
     * microtask: submitting in the same tick reads an empty draft and the
     * handler returns without asking anything.
     */
    await settle();

    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    /* Let the mint, the refusal, the refresh and the replay all settle. */
    for (let tick = 0; tick < 12; tick += 1) await settle();

    return { panel, ...route };
  };

  it('refreshes once and replays the question', async () => {
    const { panel, mints, asks } = await answer([refused(401), stream('Un Barolo.')]);

    expect(mints()).toBe(2);
    expect(asks()).toBe(2);
    expect(panel.body.querySelector('.chat-log')?.textContent).toContain('Un Barolo.');
  });

  it('gives up after one refresh rather than looping', async () => {
    /*
     * A 401 after a successful refresh means something is genuinely wrong. An
     * unbounded 401 to refresh to 401 cycle is a denial of service we would be
     * running against our own session endpoint, from a visitor's browser.
     */
    const { mints, asks } = await answer([refused(401), refused(401), stream('never')]);

    expect(mints()).toBe(2);
    expect(asks()).toBe(2);
  });

  it('does not refresh for a refusal that is not a 401', async () => {
    /* A 429 is a rate limit and a 403 is an origin. Neither is fixed by a new
     * token, and minting one wastes a request the limiter is already counting. */
    const { mints, asks } = await answer([refused(429), stream('never')]);

    expect(mints()).toBe(1);
    expect(asks()).toBe(1);
  });
});
