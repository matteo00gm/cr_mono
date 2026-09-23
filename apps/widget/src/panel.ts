import type { WidgetConfigResponse } from '@catalogorosso/api-client';
import { h, render } from 'preact';

import { readableOn } from '@catalogorosso/core/contrast';

import { trapFocus, type FocusTrap } from './a11y/focus-trap.js';
import { createCartPort, type CartPort } from './cart/port.js';
import { resolveCart, type HostPage } from './cart/resolve.js';
import { Chat, type Asker } from './components/Chat.js';
import { catalogues, localeFor } from './i18n/index.js';
import { LocaleContext, MessagesContext } from './i18n/useT.js';
import { ask } from './send.js';
import { anonId, createSession } from './session.js';

/**
 * The widget itself — everything the loader does *not* carry (P3-04).
 *
 * **This module is the whole point of the split.** The loader is 5 KB on every
 * page of a storefront (§1.1); this is fetched the first time a visitor clicks,
 * and never on a page nobody opens. A seller's Core Web Vitals are a sales
 * argument, and an unopened widget costing nothing is what makes it one.
 *
 * **It is entered once, with the shadow root the loader already made.** No
 * second host, no second style sheet, no second anything: the loader owns the
 * page and this owns what is inside it.
 *
 * **Closing is not unmounting** (P3-06). §1.3 asks that a conversation survive
 * in memory, so `close` hides the panel and leaves the chat mounted — a visitor
 * who closes it mid-answer comes back to the finished one. The component is
 * unmounted only when the page itself goes away.
 */

/** The panel's own styles. Scoped by the shadow root, like the launcher's. */
const PANEL_STYLE = [
  '.panel {',
  '  position: fixed; bottom: 88px; right: 20px; z-index: 2147483000;',
  '  width: min(380px, calc(100vw - 40px)); height: min(560px, calc(100vh - 120px));',
  '  display: flex; flex-direction: column; overflow: hidden;',
  '  background: #fff; color: #1a1a1a; border-radius: 12px;',
  '  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);',
  '  font: 15px/1.5 system-ui, sans-serif;',
  '}',
  '.panel[hidden] { display: none; }',
  /* The tenant's colour, and a foreground picked for contrast rather than taste
   * (P3-15). Set as variables so one rule decides it for every control. */
  '.panel { --accent: #7b1e3c; --on-accent: #fff; }',
  /*
   * **A focus ring that a seller's CSS reset cannot remove**, because it is
   * inside the shadow root and their stylesheet does not reach in (§1.7). It is
   * written once for everything rather than per control, so a control added
   * later inherits it.
   */
  '.panel :focus-visible {',
  '  outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px;',
  '}',
  /* The one animation, and it is off for anybody who asked for that. */
  '@media (prefers-reduced-motion: no-preference) {',
  '  .panel { animation: sommelier-open 140ms ease-out; }',
  '  @keyframes sommelier-open { from { opacity: 0; transform: translateY(8px); } }',
  '}',
  '.panel-header { padding: 12px 16px; border-bottom: 1px solid #eee; font-weight: 600; }',
  '.panel-body { flex: 1; display: flex; min-height: 0; }',
  /* One stylesheet per shadow root: the chat lives inside the panel, so its rules do too. */
  '.chat { flex: 1; display: flex; flex-direction: column; min-height: 0; }',
  '.chat-log { flex: 1; overflow-y: auto; padding: 16px; }',
  '.turn { margin: 0 0 12px; }',
  '.turn-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }',
  '.turn-visitor .turn-text { font-weight: 600; }',
  '.cards { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 8px; }',
  '.card {',
  '  display: flex; gap: 10px; align-items: flex-start;',
  '  border: 1px solid #eee; border-radius: 8px; padding: 8px 10px; font-size: 14px;',
  '}',
  '.card-image {',
  '  flex: 0 0 auto; width: 48px; height: 64px; object-fit: cover; border-radius: 4px;',
  '  background: #f6f6f6;',
  '}',
  '.card-image--missing { display: grid; place-items: center; font-size: 22px; }',
  '.card-body { min-width: 0; }',
  '.card-title { margin: 0; font-weight: 600; overflow-wrap: anywhere; }',
  '.card-reason { margin: 2px 0 0; color: #555; overflow-wrap: anywhere; }',
  '.card-meta { margin: 4px 0 0; display: flex; gap: 8px; align-items: baseline; }',
  '.card-price { font-weight: 600; }',
  '.card-badge {',
  '  font-size: 12px; padding: 1px 6px; border-radius: 999px; background: #f0e6e9; color: var(--accent);',
  '}',
  '.card-link { color: var(--accent); }',
  '.card-actions { margin: 6px 0 0; display: flex; gap: 10px; align-items: center; }',
  '.card-add {',
  '  border: 0; border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 13px;',
  '  background: var(--accent); color: var(--on-accent); cursor: pointer;',
  '}',
  '.card-add:disabled { background: #d8c3ca; cursor: default; }',
  '.card-add[data-state="done"] { background: #2f6f4f; }',
  '.card-add[data-state="failed"] { background: #8a4b00; }',
  '.chat-tools { display: flex; justify-content: flex-end; padding: 6px 12px 0; }',
  '.cart-button {',
  '  position: relative; border: 0; background: none; font: inherit; font-size: 20px;',
  '  cursor: pointer; line-height: 1; padding: 4px;',
  '}',
  '.cart-count {',
  '  position: absolute; top: -2px; right: -4px; min-width: 16px; padding: 0 4px;',
  '  border-radius: 999px; background: var(--accent); color: var(--on-accent); font-size: 11px; line-height: 16px;',
  '}',
  '.notice {',
  '  display: flex; align-items: center; gap: 8px; justify-content: space-between;',
  '  padding: 8px 16px; background: #fdf3f5; font-size: 14px;',
  '}',
  '.notice-retry { border: 0; background: none; color: var(--accent); font: inherit; cursor: pointer; }',
  '.composer { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #eee; }',
  '.composer-input { flex: 1; min-width: 0; padding: 8px 10px; font: inherit; }',
  '.composer-input:disabled { background: #f6f6f6; }',
  '.composer-send { border: 0; border-radius: 8px; padding: 8px 14px; font: inherit; }',
  '.composer-send { background: var(--accent); color: var(--on-accent); cursor: pointer; }',
  '.composer-send:disabled { background: #d8c3ca; cursor: default; }',
  '.visually-hidden {',
  '  position: absolute; width: 1px; height: 1px; overflow: hidden;',
  '  clip-path: inset(50%); white-space: nowrap;',
  '}',
].join('\n');

export interface PanelOptions {
  readonly shadow: ShadowRoot;
  readonly launcher: HTMLButtonElement;
  readonly config: WidgetConfigResponse;
  /** Where the API is, captured by the loader from the seller's script tag. */
  readonly api: string;
  /** The seller's public key, likewise. */
  readonly key: string;
  /** `data-cart` from the script tag, when the seller settled it themselves (P3-10). */
  readonly cart?: string | undefined;
  /** Injected by tests; the default resolves the host page's own cart. */
  readonly cartPort?: CartPort | undefined;
  readonly navigate?: ((url: string) => void) | undefined;
  /** Injected by tests; the default is a real session and a real stream. */
  readonly ask?: Asker | undefined;
  readonly document?: Document | undefined;
}

export interface Panel {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
  readonly open: () => void;
  readonly close: () => void;
  readonly isOpen: () => boolean;
}

/**
 * The real asker: one session for the page, one request per question.
 *
 * **Composed here, inside the widget bundle.** The loader never sees this — it
 * hands down two strings and nothing else, which is what keeps `send.ts`,
 * `session.ts` and Preact out of the 5 KB that runs on every page (§1.1).
 */
const asker = (api: string, key: string): Asker => {
  const session = createSession({ api, key });

  return async function* (message, signal) {
    yield* ask({ api, key, token: await session.token(), message, signal });
  };
};

/**
 * The storefront's own cart, decided on the page we are standing on (§1.6).
 *
 * **The session id is the widget session, and it is not available here.** P3-16
 * holds the token in a closure and deliberately hands nothing out; what the
 * Shopify line needs is an identifier that ties an order to a conversation, and
 * an anonymous per-tab id is exactly that — so `anonId()` is what ships in
 * `_somm_session` rather than the token's own session claim.
 */
const cartFor = (declared: string | undefined): CartPort =>
  createCartPort({
    adapter: resolveCart({ host: globalThis as HostPage, declared }),
    sessionId: anonId(),
  });

/**
 * Mounts the panel beside the launcher and wires the two together.
 *
 * **`aria-expanded` moves with the panel**, because the launcher is the thing a
 * screen reader announces and a button that says `false` while a dialog is open
 * is worse than one that says nothing (§1.7).
 */
export const mountPanel = ({
  shadow,
  launcher,
  config,
  api,
  key,
  cart,
  cartPort,
  navigate,
  ask: ask_,
  document: document_ = document,
}: PanelOptions): Panel => {
  const style = document_.createElement('style');

  style.textContent = PANEL_STYLE;

  const element = document_.createElement('div');

  element.className = 'panel';
  element.hidden = true;
  element.setAttribute('role', 'dialog');
  /*
   * **False until the trap is on.** `aria-modal` tells assistive technology the
   * rest of the page is inert, and that is only true while `Tab` is actually
   * being held inside (P3-15).
   */
  element.setAttribute('aria-modal', 'false');
  element.setAttribute('aria-label', config.welcomeMessage);

  /*
   * The winery's own colour, with a foreground chosen for contrast rather than
   * assumed (P3-15, §1.7). A seller who picked a pale gold gets black text on
   * it; one who picked a deep bordeaux gets white, and neither has to know.
   */
  element.style.setProperty('--accent', config.theme.primaryColor);
  element.style.setProperty('--on-accent', readableOn(config.theme.primaryColor));

  const header = document_.createElement('div');

  header.className = 'panel-header';
  header.textContent = config.welcomeMessage;

  const body = document_.createElement('div');

  body.className = 'panel-body';

  element.append(header, body);
  shadow.append(style, element);

  /*
   * The locale is decided once, here: the tenant's setting, overridden by the
   * visitor's own browser when we have a catalogue for it (P3-14). Everything
   * below reads it from the context rather than being handed it four times.
   */
  const locale = localeFor(config.locale, navigator.language);

  render(
    h(
      LocaleContext.Provider,
      { value: locale },
      h(
        MessagesContext.Provider,
        { value: catalogues[locale] },
        h(Chat, {
          ask: ask_ ?? asker(api, key),
          status: config.status,
          cart: cartPort ?? cartFor(cart),
          cartUrl: config.cartUrl,
          navigate,
        }),
      ),
    ),
    body,
  );

  let trap: FocusTrap | undefined;

  const setOpen = (open: boolean): void => {
    element.hidden = !open;
    element.setAttribute('aria-modal', String(open));
    launcher.setAttribute('aria-expanded', String(open));

    if (!open) {
      trap?.release();
      trap = undefined;

      return;
    }

    /*
     * **Focus moves in, and `Escape` is the way out** (§1.7). A dialog that
     * opens without taking focus is one a screen-reader user does not know is
     * there; one that traps with no exit is a shop a keyboard user cannot leave.
     */
    trap = trapFocus(element, {
      onEscape: () => {
        setOpen(false);
      },
      returnTo: launcher,
    });
  };

  return {
    element,
    body,
    open: () => {
      setOpen(true);
    },
    close: () => {
      setOpen(false);
    },
    isOpen: () => !element.hidden,
  };
};
