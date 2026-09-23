import type { WidgetConfigResponse } from '@catalogorosso/api-client';
import { contrastRatio } from '@catalogorosso/core/contrast';
import axe from 'axe-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { focusableIn, trapFocus } from '../src/a11y/focus-trap.js';
import type { Asker } from '../src/components/Chat.js';
import { mountPanel, type Panel } from '../src/panel.js';

/**
 * Using the widget without a mouse, and reading it (P3-15, §1.7).
 *
 * **A commercial issue before an ethical one.** European accessibility
 * requirements increasingly apply to storefronts, and a widget that fails them
 * becomes the seller's liability rather than ours.
 *
 * **What JSDOM can and cannot say.** It parses and computes no layout, so axe's
 * colour-contrast and visibility rules cannot run here — the structural ones
 * can, and they are the ones a code change breaks. The contrast half is checked
 * arithmetically instead, against the same numbers the console will use, and
 * P3-18 runs the full rule set in a browser.
 */

const config: WidgetConfigResponse = {
  status: 'ACTIVE',
  locale: 'it',
  theme: { primaryColor: '#7b1e3c', position: 'bottom-right', avatarUrl: null },
  welcomeMessage: 'Posso consigliarle un vino?',
  cartUrl: '/cart',
  quotaState: 'ok',
};

const API = 'https://api.example';
const KEY = 'pk_test_abc';

const silent: Asker = () => ({
  // eslint-disable-next-line @typescript-eslint/require-await -- an async iterable is the contract
  async *[Symbol.asyncIterator]() {
    yield { type: 'done' } as const;
  },
});

let shadow: ShadowRoot;
let launcher: HTMLButtonElement;

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

const mount = (overrides: Partial<WidgetConfigResponse> = {}): Panel =>
  mountPanel({
    shadow,
    launcher,
    config: { ...config, ...overrides },
    api: API,
    key: KEY,
    ask: silent,
    navigate: () => undefined,
  });

const press = (element: HTMLElement, key: string, shiftKey = false): void => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
};

describe('opening and closing with a keyboard', () => {
  it('takes focus into the panel, on the thing a visitor wants', () => {
    /* A dialog that opens without taking focus is one a screen-reader user does
     * not know is there. The composer, because they came here to type. */
    const panel = mount();

    panel.open();

    expect(shadow.activeElement).toBe(panel.body.querySelector('.composer-input'));
  });

  it('gives focus back to the launcher on close', () => {
    /* Otherwise a keyboard user lands at the top of the shop with no idea why. */
    const panel = mount();

    panel.open();
    panel.close();

    expect(shadow.activeElement).toBe(launcher);
  });

  it('closes on Escape', () => {
    const panel = mount();

    panel.open();
    press(panel.element, 'Escape');

    expect(panel.isOpen()).toBe(false);
  });

  it('gives focus back when Escape closed it, not only when the launcher did', () => {
    const panel = mount();

    panel.open();
    press(panel.element, 'Escape');

    expect(shadow.activeElement).toBe(launcher);
  });

  it('says the rest of the page is inert only while it actually is', () => {
    /*
     * `aria-modal` is a claim about the whole page. It is true while `Tab` is
     * being held inside and false the moment it is not.
     */
    const panel = mount();

    expect(panel.element.getAttribute('aria-modal')).toBe('false');

    panel.open();
    expect(panel.element.getAttribute('aria-modal')).toBe('true');

    panel.close();
    expect(panel.element.getAttribute('aria-modal')).toBe('false');
  });
});

describe('the focus trap', () => {
  const build = (html: string): HTMLElement => {
    const element = document.createElement('div');

    element.append(...[...new DOMParser().parseFromString(html, 'text/html').body.childNodes]);
    shadow.append(element);

    return element;
  };

  it('finds every control a keyboard can reach, in order', () => {
    const element = build(
      '<a href="#a">a</a><button>b</button><input /><select></select><textarea></textarea>',
    );

    expect(focusableIn(element).map((node) => node.tagName)).toEqual([
      'A',
      'BUTTON',
      'INPUT',
      'SELECT',
      'TEXTAREA',
    ]);
  });

  it('skips a control inside a hidden subtree', () => {
    const element = build('<button>one</button><div hidden><button>two</button></div>');

    expect(focusableIn(element)).toHaveLength(1);
  });

  it('skips a disabled control, which Tab does not stop on', () => {
    const element = build('<button>one</button><button disabled>two</button>');

    expect(focusableIn(element)).toHaveLength(1);
  });

  it('skips an element taken out of the tab order', () => {
    const element = build('<button>one</button><div tabindex="-1">two</div>');

    expect(focusableIn(element)).toHaveLength(1);
  });

  it('wraps forward from the last control to the first', () => {
    const element = build('<button id="one">one</button><button id="two">two</button>');
    const [first, last] = focusableIn(element);

    trapFocus(element, { onEscape: () => undefined });
    last?.focus();
    press(element, 'Tab');

    expect(shadow.activeElement).toBe(first);
  });

  it('wraps backward from the first control to the last', () => {
    const element = build('<button id="one">one</button><button id="two">two</button>');
    const [first, last] = focusableIn(element);

    trapFocus(element, { onEscape: () => undefined });
    first?.focus();
    press(element, 'Tab', true);

    expect(shadow.activeElement).toBe(last);
  });

  it('leaves Tab alone in the middle, so the browser does the ordinary thing', () => {
    const element = build('<button>one</button><button>two</button><button>three</button>');
    const middle = focusableIn(element)[1];

    trapFocus(element, { onEscape: () => undefined });
    middle?.focus();

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });

    element.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('lets Tab through when there is nothing to trap', () => {
    /* Swallowing the key would leave a keyboard user stuck on an empty panel. */
    const element = build('<p>niente</p>');

    trapFocus(element, { onEscape: () => undefined });

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });

    element.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('stops trapping once it is released', () => {
    const element = build('<button id="one">one</button><button id="two">two</button>');
    const [first, last] = focusableIn(element);

    trapFocus(element, { onEscape: () => undefined }).release();
    last?.focus();

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });

    element.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(shadow.activeElement).not.toBe(first);
  });

  it('is safe to release twice', () => {
    const element = build('<button>one</button>');
    const trap = trapFocus(element, { onEscape: () => undefined });

    trap.release();

    expect(() => {
      trap.release();
    }).not.toThrow();
  });

  it('calls back on Escape rather than closing anything itself', () => {
    /* The trap holds focus; the caller owns the panel. */
    const element = build('<button>one</button>');
    const onEscape = vi.fn();

    trapFocus(element, { onEscape });
    press(element, 'Escape');

    expect(onEscape).toHaveBeenCalledOnce();
  });
});

describe('the tenant own colour', () => {
  it('uses it, rather than ours', () => {
    expect(
      mount({ theme: { ...config.theme, primaryColor: '#123456' } }).element.style.getPropertyValue(
        '--accent',
      ),
    ).toBe('#123456');
  });

  it('picks a foreground that can be read on it', () => {
    /* A seller who picked a pale gold gets black text on it, and does not have
     * to know that is a decision. */
    const pale = mount({ theme: { ...config.theme, primaryColor: '#e8c66a' } });

    expect(pale.element.style.getPropertyValue('--on-accent')).toBe('#000000');
  });

  it('keeps every accent pairing above the AA threshold', () => {
    for (const primary of ['#7b1e3c', '#e8c66a', '#123456', '#ffffff', '#000000']) {
      const panel = mount({ theme: { ...config.theme, primaryColor: primary } });
      const foreground = panel.element.style.getPropertyValue('--on-accent');

      expect(contrastRatio(foreground, primary) ?? 0, primary).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('what the panel promises assistive technology', () => {
  it('names itself, so a dialog is not announced as "dialog"', () => {
    expect(mount().element.getAttribute('aria-label')).toBe(config.welcomeMessage);
  });

  it('labels the composer', () => {
    const panel = mount();
    const input = panel.body.querySelector('.composer-input');

    expect(input?.id).not.toBe('');
    expect(panel.body.querySelector(`label[for="${String(input?.id)}"]`)).not.toBeNull();
  });

  it('animates only for a visitor who did not ask us not to', () => {
    /* The one animation in the panel, and it is inside the media query rather
     * than beside it. */
    const panel = mount();
    const style = panel.element.getRootNode() as ShadowRoot;
    const sheet = [...style.querySelectorAll('style')]
      .map((node) => node.textContent ?? '')
      .join('\n');
    const guarded = sheet.slice(sheet.indexOf('@media (prefers-reduced-motion: no-preference)'));

    /* The *declaration*, not just the keyframes: moving the animation out of
     * the query while leaving `@keyframes` inside it reads the same otherwise. */
    expect(sheet).toContain('animation: sommelier-open');
    expect(guarded).toContain('animation: sommelier-open');
  });

  it('draws a focus ring a seller stylesheet cannot remove', () => {
    // Inside the shadow root, where their reset does not reach.
    const panel = mount();

    expect(
      [...shadow.querySelectorAll('style')].some((node) =>
        (node.textContent ?? '').includes(':focus-visible'),
      ),
      panel.element.className,
    ).toBe(true);
  });

  it('passes axe on every structural rule it can run here', async () => {
    /*
     * JSDOM computes no layout, so contrast and visibility rules cannot run —
     * `runOnly` keeps the result honest rather than passing on rules that were
     * silently skipped. P3-18 runs the whole set in a browser.
     */
    const panel = mount();

    panel.open();

    const results = await axe.run(panel.element, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
