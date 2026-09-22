import type { WidgetConfigResponse } from '@catalogorosso/api-client';

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
 * P3-06 fills the panel with the chat. What is here is the frame it mounts
 * into and the open/close behaviour the launcher drives.
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
  '.panel-body { flex: 1; overflow-y: auto; padding: 16px; }',
].join('\n');

export interface PanelOptions {
  readonly shadow: ShadowRoot;
  readonly launcher: HTMLButtonElement;
  readonly config: WidgetConfigResponse;
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
