import type { WidgetConfigResponse } from '@catalogorosso/api-client';
import { h, render } from 'preact';

import { Chat, type Asker } from './components/Chat.js';
import { catalogues, localeFor } from './i18n/index.js';
import { MessagesContext } from './i18n/useT.js';
import { ask } from './send.js';
import { createSession } from './session.js';

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
  '.panel-header { padding: 12px 16px; border-bottom: 1px solid #eee; font-weight: 600; }',
  '.panel-body { flex: 1; display: flex; min-height: 0; }',
  /* One stylesheet per shadow root: the chat lives inside the panel, so its rules do too. */
  '.chat { flex: 1; display: flex; flex-direction: column; min-height: 0; }',
  '.chat-log { flex: 1; overflow-y: auto; padding: 16px; }',
  '.turn { margin: 0 0 12px; }',
  '.turn-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }',
  '.turn-visitor .turn-text { font-weight: 600; }',
  '.cards { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 8px; }',
  '.card { border: 1px solid #eee; border-radius: 8px; padding: 8px 10px; font-size: 14px; }',
  '.notice {',
  '  display: flex; align-items: center; gap: 8px; justify-content: space-between;',
  '  padding: 8px 16px; background: #fdf3f5; font-size: 14px;',
  '}',
  '.notice-retry { border: 0; background: none; color: #7b1e3c; font: inherit; cursor: pointer; }',
  '.composer { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #eee; }',
  '.composer-input { flex: 1; min-width: 0; padding: 8px 10px; font: inherit; }',
  '.composer-input:disabled { background: #f6f6f6; }',
  '.composer-send { border: 0; border-radius: 8px; padding: 8px 14px; font: inherit; }',
  '.composer-send { background: #7b1e3c; color: #fff; cursor: pointer; }',
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
  ask: ask_,
  document: document_ = document,
}: PanelOptions): Panel => {
  const style = document_.createElement('style');

  style.textContent = PANEL_STYLE;

  const element = document_.createElement('div');

  element.className = 'panel';
  element.hidden = true;
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'false');
  element.setAttribute('aria-label', config.welcomeMessage);

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
      MessagesContext.Provider,
      { value: catalogues[locale] },
      h(Chat, { ask: ask_ ?? asker(api, key), status: config.status }),
    ),
    body,
  );

  const setOpen = (open: boolean): void => {
    element.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
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
