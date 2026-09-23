import type { WidgetConfigResponse } from '@catalogorosso/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lazyPanel, type WidgetModule } from '../src/lazy.js';
import { mountPanel } from '../src/panel.js';

/**
 * Fetching the widget on first click (P3-04).
 *
 * **The assertion the row is about is a request that does not happen.** A page
 * view costs one small script; the bundle arrives when somebody asks for it,
 * and never on the overwhelming majority of pages where nobody does. That is a
 * seller's Core Web Vitals, which is a sales argument.
 *
 * The second is the double click. A visitor on a slow connection presses the
 * launcher again, and the second press must not buy a second bundle.
 */

const config: WidgetConfigResponse = {
  status: 'ACTIVE',
  locale: 'it',
  theme: { primaryColor: '#7b1e3c', position: 'bottom-right', avatarUrl: null },
  welcomeMessage: 'Posso consigliarle un vino?',
  cartUrl: 'https://cantina-rossi.example/cart',
  quotaState: 'ok',
};

/** What the loader captured from the seller's script tag, and passes straight through. */
const API = 'https://api.example';
const KEY = 'pk_test_abc';

let shadow: ShadowRoot;
let launcher: HTMLButtonElement;

/** A module that resolves when the test says so, so "in flight" is a state to test in. */
const deferred = () => {
  let release: (module: WidgetModule) => void = () => {
    /* Replaced below, before anything can call it. */
  };
  const promise = new Promise<WidgetModule>((resolve) => {
    release = resolve;
  });

  return {
    promise,
    release: (module: WidgetModule) => {
      release(module);
    },
  };
};

const loading = () => {
  const load = vi.fn(() => Promise.resolve<WidgetModule>({ mountPanel }));

  return load;
};

beforeEach(() => {
  document.body.replaceChildren();

  const host = document.createElement('sommelier-widget');

  shadow = host.attachShadow({ mode: 'open' });
  launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.setAttribute('aria-expanded', 'false');
  shadow.append(launcher);
  document.body.append(host);
});

describe('before anybody clicks', () => {
  it('requests nothing', () => {
    /*
     * **The whole row, and it can only be checked as an absence.** Every page
     * of a storefront runs the loader; almost none of them open the widget.
     */
    const load = loading();

    lazyPanel({ shadow, launcher, config, api: API, key: KEY, load });

    expect(load).not.toHaveBeenCalled();
  });

  it('mounts no panel', () => {
    const load = loading();

    lazyPanel({ shadow, launcher, config, api: API, key: KEY, load });

    expect(shadow.querySelector('.panel')).toBeNull();
  });
});

describe('the panel, once it exists', () => {
  it('is mounted closed, so it does not flash open on arrival', () => {
    /*
     * Mounting and opening are separate on purpose. A panel that rendered open
     * would appear for an instant on the first click *before* anything decided
     * it should — and would appear at all for a caller that only wanted it
     * built.
     */
    const panel = mountPanel({ shadow, launcher, config, api: API, key: KEY });

    expect(panel.isOpen()).toBe(false);
    expect(panel.element.hasAttribute('hidden')).toBe(true);
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the first click', () => {
  it('fetches the bundle and opens the panel', async () => {
    const load = loading();
    const lazy = lazyPanel({ shadow, launcher, config, api: API, key: KEY, load });

    await lazy.toggle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(shadow.querySelector('.panel')?.hasAttribute('hidden')).toBe(false);
  });

  it('says the launcher is working while the bundle arrives', async () => {
    /*
     * A button that does nothing for three hundred milliseconds on a slow
     * connection is a button a visitor presses again — and `aria-busy` is what
     * a screen reader reads in the meantime.
     */
    const { promise, release } = deferred();
    const lazy = lazyPanel({ shadow, launcher, config, api: API, key: KEY, load: () => promise });

    const opening = lazy.toggle();

    expect(launcher.getAttribute('aria-busy')).toBe('true');

    release({ mountPanel });
    await opening;

    expect(launcher.hasAttribute('aria-busy')).toBe(false);
  });

  it('tells a screen reader the panel is open', async () => {
    // A launcher that says `aria-expanded="false"` over an open dialog is worse
    // than one that says nothing at all (§1.7).
    const lazy = lazyPanel({ shadow, launcher, config, api: API, key: KEY, load: loading() });

    await lazy.toggle();

    expect(launcher.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('clicking again', () => {
  it('buys one bundle, not two, even before the first has arrived', async () => {
    /*
     * **The case a resolved-module cache would miss.** Caching the *promise* is
     * what makes a second click during the first request await the same one;
     * caching the module only helps once the module exists.
     */
    const { promise, release } = deferred();
    const load = vi.fn(() => promise);
    const lazy = lazyPanel({ shadow, launcher, config, api: API, key: KEY, load });

    const first = lazy.toggle();
    const second = lazy.toggle();

    release({ mountPanel });
    await Promise.all([first, second]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(lazy.loads()).toBe(1);
  });

  it('closes a panel that is open, and opens it again after', async () => {
    const lazy = lazyPanel({ shadow, launcher, config, api: API, key: KEY, load: loading() });

    await lazy.toggle();
    await lazy.toggle();

    expect(shadow.querySelector('.panel')?.hasAttribute('hidden')).toBe(true);
    expect(launcher.getAttribute('aria-expanded')).toBe('false');

    await lazy.toggle();

    expect(shadow.querySelector('.panel')?.hasAttribute('hidden')).toBe(false);
  });

  it('mounts one panel however many times it is toggled', async () => {
    const lazy = lazyPanel({ shadow, launcher, config, api: API, key: KEY, load: loading() });

    await lazy.toggle();
    await lazy.toggle();
    await lazy.toggle();

    expect(shadow.querySelectorAll('.panel')).toHaveLength(1);
  });
});

describe('preloading on hover', () => {
  it('fetches the bundle without opening anything', () => {
    const load = loading();
    const lazy = lazyPanel({
      shadow,
      launcher,
      config,
      api: API,
      key: KEY,
      load,
      whenIdle: (run) => {
        run();
      },
    });

    lazy.preload();

    expect(load).toHaveBeenCalledTimes(1);
    expect(shadow.querySelector('.panel')).toBeNull();
  });

  it('is not paid for twice when the click follows', async () => {
    const load = loading();
    const lazy = lazyPanel({
      shadow,
      launcher,
      config,
      api: API,
      key: KEY,
      load,
      whenIdle: (run) => {
        run();
      },
    });

    lazy.preload();
    await lazy.toggle();

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never lets a failure reach the page', async () => {
    /*
     * A preload nobody asked for, failing, must not put an unhandled rejection
     * in a seller's console. The click that follows tries again.
     */
    const lazy = lazyPanel({
      shadow,
      launcher,
      config,
      api: API,
      key: KEY,
      load: () => Promise.reject(new Error('offline')),
      whenIdle: (run) => {
        run();
      },
    });

    expect(() => {
      lazy.preload();
    }).not.toThrow();

    await Promise.resolve();
  });

  it('runs when the browser is idle rather than at once', () => {
    // A preload that blocked would be worse than no preload: it is a nicety,
    // and a nicety on a seller's storefront must never cost them anything.
    const ran: (() => void)[] = [];
    const load = loading();
    const lazy = lazyPanel({
      shadow,
      launcher,
      config,
      api: API,
      key: KEY,
      load,
      whenIdle: (run) => ran.push(run),
    });

    lazy.preload();

    expect(load).not.toHaveBeenCalled();

    ran[0]?.();

    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('when the bundle does not arrive', () => {
  it('leaves the launcher usable rather than stuck', async () => {
    const lazy = lazyPanel({
      shadow,
      launcher,
      config,
      api: API,
      key: KEY,
      load: () => Promise.reject(new Error('offline')),
    });

    await lazy.toggle();

    expect(launcher.hasAttribute('aria-busy')).toBe(false);
    expect(shadow.querySelector('.panel')).toBeNull();
  });

  it('tries again on the next click rather than failing instantly forever', async () => {
    /*
     * A cached rejection would make every later click fail without a request —
     * so a visitor who reconnects still cannot open the widget, and nothing
     * anywhere says why.
     */
    let attempts = 0;
    const lazy = lazyPanel({
      shadow,
      launcher,
      config,
      api: API,
      key: KEY,
      load: () => {
        attempts += 1;

        return attempts === 1
          ? Promise.reject(new Error('offline'))
          : Promise.resolve<WidgetModule>({ mountPanel });
      },
    });

    await lazy.toggle();
    await lazy.toggle();

    expect(attempts).toBe(2);
    expect(shadow.querySelector('.panel')?.hasAttribute('hidden')).toBe(false);
  });
});

describe('the idle callback it uses by default', () => {
  it('works on a browser that has requestIdleCallback', async () => {
    const idle = vi.fn((run: () => void) => {
      run();
    });

    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = idle;

    const load = loading();

    lazyPanel({ shadow, launcher, config, api: API, key: KEY, load }).preload();
    await Promise.resolve();

    expect(idle).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);

    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  });

  it('falls back to a timeout on a browser that does not', () => {
    /*
     * `requestIdleCallback` is not in every browser, and the preload is a
     * nicety either way — but on a browser that has neither the widget still
     * has to open, so the fallback must exist and must not block.
     */
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;

    vi.useFakeTimers();

    const load = loading();

    lazyPanel({ shadow, launcher, config, api: API, key: KEY, load }).preload();

    expect(load).not.toHaveBeenCalled();

    vi.runAllTimers();
    vi.useRealTimers();

    expect(load).toHaveBeenCalledTimes(1);
  });
});
