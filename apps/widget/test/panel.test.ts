import type { WidgetConfigResponse } from '@catalogorosso/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  mountPanel({ shadow, launcher, config, api: API, key: KEY, ask });

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

    mountPanel({ shadow, launcher, config, api: API, key: KEY });

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
