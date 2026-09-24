import type { WidgetConfigResponse } from '@catalogorosso/api-client';

import type { Panel, PanelOptions } from './panel.js';

/**
 * Fetching the widget on first click (P3-04, §1.2).
 *
 * **A page view costs one small script and nothing else.** Deferring to the
 * first click keeps a seller's Core Web Vitals untouched, which is a sales
 * argument rather than a nicety — and it means the overwhelming majority of
 * page views, on which nobody opens the widget, cost us nothing at all.
 *
 * **The promise is cached, not the module.** A visitor who double-clicks, or
 * clicks while the preload is in flight, must get one request: caching the
 * *promise* makes that true even when the second call arrives before the first
 * has resolved, which caching the resolved module cannot.
 */

/** What a lazily-loaded widget module has to provide. Narrow on purpose. */
export interface WidgetModule {
  readonly mountPanel: (options: PanelOptions) => Panel;
}

export type LoadWidget = () => Promise<WidgetModule>;

/**
 * The real import.
 *
 * Written as a function rather than inlined so a test can stand in for it —
 * and, more importantly, so there is exactly one `import()` in the codebase for
 * a bundler to split on. A second one elsewhere would be a second chunk.
 */
export const importWidget: LoadWidget = () => import('./widget.js');

export interface LazyPanelOptions {
  readonly shadow: ShadowRoot;
  readonly launcher: HTMLButtonElement;
  readonly config: WidgetConfigResponse;
  /* Two strings, passed straight through. The loader knows where the API is
   * and what the seller's key is; it must not know how a question is asked, or
   * the chat ends up in the 5 KB that runs on every page (P3-06). */
  readonly api: string;
  readonly key: string;
  /** `data-cart`, when the seller wrote one. Forwarded, never interpreted here. */
  readonly cart?: string | undefined;
  readonly load?: LoadWidget | undefined;
  readonly document?: Document | undefined;
  /** Injected so a test can run the idle callback rather than wait for one. */
  readonly whenIdle?: ((run: () => void) => void) | undefined;
}

export interface LazyPanel {
  /** Opens the panel, fetching the bundle first if this is the first time. */
  readonly toggle: () => Promise<void>;
  /** Starts the fetch without opening anything. Safe to call repeatedly. */
  readonly preload: () => void;
  /** How many times the module was actually requested. For tests and for nothing else. */
  readonly loads: () => number;
}

/** Runs `run` when the browser is idle, or soon, or not at all — never blocking. */
const idle = (run: () => void): void => {
  const request = (globalThis as { requestIdleCallback?: (cb: () => void) => void })
    .requestIdleCallback;

  if (typeof request === 'function') {
    request(run);

    return;
  }

  /*
   * `requestIdleCallback` is not in every browser, and a timeout is the
   * conventional stand-in. Either way this is a *nicety*: it must never be the
   * thing that makes the widget work, because on the browser that has neither
   * the widget still has to open.
   */
  setTimeout(run, 0);
};

/**
 * Wires the launcher to a widget that is not there yet.
 *
 * **The launcher says it is working while the bundle arrives.** A button that
 * does nothing for three hundred milliseconds on a slow connection is a button
 * a visitor presses again, and the second press must not cost a second request.
 *
 * **A failed load leaves the launcher usable.** The bundle can fail to arrive —
 * a flaky network, a CSP nobody warned us about — and the right answer is a
 * launcher that can be pressed again rather than one stuck saying `loading`.
 */
export const lazyPanel = ({
  shadow,
  launcher,
  config,
  api,
  key,
  cart,
  load = importWidget,
  document: document_ = document,
  whenIdle = idle,
}: LazyPanelOptions): LazyPanel => {
  let pending: Promise<WidgetModule> | undefined;
  let panel: Panel | undefined;
  let loads = 0;

  const fetchModule = (): Promise<WidgetModule> => {
    /*
     * The promise, not the module. A second click arriving before the first
     * resolves finds this already set and awaits the same request — which is
     * the case a resolved-module cache would miss, and the common one.
     */
    pending ??= (() => {
      loads += 1;

      return load();
    })();

    return pending;
  };

  return {
    loads: () => loads,

    preload: () => {
      whenIdle(() => {
        /*
         * Swallowed: a preload that fails has cost nothing and told the visitor
         * nothing, and the click that follows will try again. Letting it reject
         * would put an unhandled rejection in a seller's console for a request
         * nobody asked for.
         */
        void fetchModule().catch(() => undefined);
      });
    },

    toggle: async () => {
      if (panel !== undefined) {
        if (panel.isOpen()) panel.close();
        else panel.open();

        return;
      }

      launcher.setAttribute('aria-busy', 'true');

      try {
        const module = await fetchModule();

        panel = module.mountPanel({
          shadow,
          launcher,
          config,
          api,
          key,
          cart,
          document: document_,
        });
        panel.open();
      } catch {
        /*
         * The bundle did not arrive. `pending` is cleared so the next click is
         * a fresh attempt rather than a re-await of the same rejection — a
         * launcher that fails once and then fails instantly forever is worse
         * than one that simply retries.
         */
        pending = undefined;
      } finally {
        launcher.removeAttribute('aria-busy');
      }
    },
  };
};
