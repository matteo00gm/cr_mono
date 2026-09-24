/**
 * The script a seller pastes into their storefront (P3-01, §1.1).
 *
 * **This file runs on every page of somebody else's shop**, which is the whole
 * of why it is written the way it is. Its size is a promise to the seller
 * (P3-02 enforces it in CI) and its side effects are too: one custom element,
 * one global, and nothing else touched.
 *
 * **A bug here must never break a storefront.** That is the difference between
 * a support ticket and a cancellation, so every entry point is wrapped and
 * fails silently — the widget not appearing is bad, and a seller's checkout
 * throwing is unsurvivable.
 *
 * **No `eval`, no `new Function`, no `document.write`.** Sellers run this
 * alongside a payment form; a CSP that forbids them is one we must pass, and a
 * seller who reads the source must find nothing that could execute a string.
 *
 * **The launcher only.** The widget itself is a second bundle, fetched when a
 * visitor asks for it (P3-04) — so a page nobody clicks costs one small script
 * and no model call, no session, no query.
 */

/** The element the loader mounts. A custom name, so a page's own CSS cannot reach inside. */
export const HOST_TAG = 'sommelier-widget';

/** The one global. Named so a second copy of the script can see the first. */
export const GLOBAL = '__sommelier';

export interface SommelierGlobal {
  /** The public key the seller pasted, as `data-key`. */
  readonly key: string;
  /** Where the API is, for the bundle that comes later. Overridable for a staging site. */
  readonly api: string;
  /**
   * Which cart this storefront has, when the seller said (`data-cart`).
   *
   * Only needed when detection cannot answer: an event-contract cart (P3-12)
   * cannot be detected at all — there is no API for "does anything listen for
   * this event" — and a headless Shopify storefront sets no `window.Shopify`.
   */
  readonly cart?: string | undefined;
  /** Set once mounted, so a double inclusion is a no-op rather than a second launcher. */
  mounted: boolean;
}

declare global {
  /**
   * Optional, so a test can remove it between cases.
   *
   * `var` because that is how a global is declared in a `declare global` block;
   * `| undefined` because the page a seller runs this on has never heard of it
   * until the line below sets it.
   */
  var __sommelier: SommelierGlobal | undefined;
}

/**
 * Read from `document.currentScript`, synchronously, at module top level.
 *
 * **`currentScript` is null inside any async callback**, and a loader that read
 * it later would find nothing and mount nothing — with no error, on the
 * seller's site, discovered by the seller. Captured here and passed down.
 */
const scriptAttribute = (name: string): string | undefined => {
  const script = document.currentScript;

  return script instanceof HTMLScriptElement ? (script.dataset[name] ?? undefined) : undefined;
};

/** Where the API lives when the seller has not said otherwise. */
export const DEFAULT_API = 'https://api.catalogorosso.com';

/**
 * The launcher, as elements.
 *
 * **Built node by node, never from a string.** `innerHTML` is banned in this
 * package by an ESLint rule (§3.7, P3-08) and the reason applies here first:
 * nothing in this file has a legitimate use for it, so the day something does
 * is the day to look hard at why.
 */
const buildLauncher = (document_: Document, label: string): HTMLButtonElement => {
  const button = document_.createElement('button');

  button.type = 'button';
  button.setAttribute('part', 'launcher');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', label);
  button.textContent = '\u{1F377}';

  return button;
};

/** The launcher's styles, scoped by the shadow root rather than by a class name nobody owns. */
const LAUNCHER_STYLE = [
  ':host { all: initial; }',
  'button {',
  '  position: fixed; bottom: 20px; right: 20px; z-index: 2147483000;',
  '  width: 56px; height: 56px; border: 0; border-radius: 50%;',
  '  background: #7b1e3c; color: #fff; font-size: 24px; line-height: 1;',
  '  cursor: pointer; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);',
  '}',
  'button:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }',
  '@media (prefers-reduced-motion: no-preference) { button { transition: transform 120ms; } }',
  'button:hover { transform: scale(1.05); }',
].join('\n');

/**
 * What a switched-off winery says on the launcher (P3-07, §1.3).
 *
 * **Written out here rather than read from the catalogue**, and that is a
 * deliberate duplication. P3-03 stops before the widget bundle is ever
 * requested, so there is no catalogue on the page to read — and importing one
 * would put it in both entries, which Rollup answers with a shared chunk the
 * loader statically imports. That is exactly the collapse P3-05's budget check
 * refuses. One sentence in two places is cheaper than 5 KB on every page view
 * of every storefront, and `loader.test.ts` pins the two together so they
 * cannot drift.
 */
export const DISABLED_LABEL = 'Il sommelier AI non è attivo al momento.';

export interface MountOptions {
  readonly document?: Document | undefined;
  /** What the launcher announces to a screen reader. Italian, like the shop. */
  readonly label?: string | undefined;
}

export interface Mounted {
  readonly host: HTMLElement;
  readonly shadow: ShadowRoot;
  readonly launcher: HTMLButtonElement;
}

/**
 * What a launcher does when it is pressed (P3-04).
 *
 * **Handed in rather than imported**, so this file keeps no reference to the
 * widget bundle at all. An import here — even a type-only one that a bundler
 * usually erases — is one refactor away from becoming a real edge, and the
 * whole promise of §1.1 is that the two entries share no chunk.
 */
export interface LauncherBehaviour {
  readonly onPress: () => void;
  readonly onHover?: (() => void) | undefined;
}

/**
 * Wires a launcher to what should happen when somebody uses it.
 *
 * `pointerenter` is a hint and `click` is the request. The hint is separate
 * because a visitor who hovers has not asked for anything, and P3-04's preload
 * must never be what makes the widget work.
 */
export const attach = (launcher: HTMLButtonElement, behaviour: LauncherBehaviour): void => {
  launcher.addEventListener('click', () => {
    behaviour.onPress();
  });

  if (behaviour.onHover !== undefined) {
    const hover = behaviour.onHover;

    launcher.addEventListener('pointerenter', () => {
      hover();
    });
  }
};

/**
 * Creates the host element and its launcher.
 *
 * **An *open* shadow root.** Closed buys no security worth having — the page
 * already has our public key, and anything in the shadow root is reachable
 * through the handle we hold anyway. Open is what lets us debug a seller's site
 * from a screenshot of their console.
 *
 * **Idempotent by the global, not by a DOM query.** A seller who pastes the
 * snippet in a header partial *and* a template renders it twice; asking the
 * document whether a host exists is a race when two copies run in the same
 * tick, and a flag set synchronously is not.
 */
export const mount = ({
  document: document_ = document,
  label = 'Apri il sommelier',
}: MountOptions = {}): Mounted | undefined => {
  const existing = globalThis.__sommelier;

  if (existing === undefined || existing.mounted) return undefined;

  existing.mounted = true;

  const host = document_.createElement(HOST_TAG);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document_.createElement('style');

  style.textContent = LAUNCHER_STYLE;

  const launcher = buildLauncher(document_, label);

  shadow.append(style, launcher);
  document_.body.append(host);

  return { host, shadow, launcher };
};

/**
 * Reads the seller's attributes and mounts, or does nothing at all.
 *
 * **Everything is inside the try.** A missing key, a `document.body` that is
 * not there yet, a browser without `attachShadow` — each of those should leave
 * the storefront exactly as it was. Silent, because the alternative is an
 * uncaught error in somebody else's error tracker with our name on it.
 */
export const start = (options: MountOptions = {}): Mounted | undefined => {
  try {
    const key = scriptAttribute('key');

    if (key === undefined || key === '') return undefined;

    globalThis.__sommelier ??= {
      key,
      api: scriptAttribute('api') ?? DEFAULT_API,
      cart: scriptAttribute('cart'),
      mounted: false,
    };

    return mount(options);
  } catch {
    /*
     * Swallowed on purpose, and this is the one place in the repository where
     * that is right. There is no logger on a seller's page that is ours to
     * write to, and a widget that failed to appear is a problem we find from
     * the config endpoint's own metrics rather than from their console.
     */
    return undefined;
  }
};
