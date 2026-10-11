import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attach, DEFAULT_API, GLOBAL, HOST_TAG, LEFT, mount, start } from '../src/loader.js';

/**
 * The script a seller pastes into their storefront (P3-01).
 *
 * **The assertions that matter are about what it does *not* do.** It runs on
 * every page of somebody else's shop, so the interesting failures are a second
 * launcher, a global nobody asked for, and — the one that ends a subscription
 * rather than opening a ticket — an exception escaping into a checkout page.
 */

/** Globals present before the loader runs, so a new one is visible by difference. */
let before: Set<string>;

const withScript = (attributes: Record<string, string>, run: () => void): void => {
  const script = document.createElement('script');

  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
  document.head.append(script);

  /*
   * `document.currentScript` is read-only and null outside script execution,
   * which is the whole hazard P3-01 is written around — so it is defined here
   * to stand in for a browser running the tag.
   */
  Object.defineProperty(document, 'currentScript', { value: script, configurable: true });

  try {
    run();
  } finally {
    script.remove();
    Object.defineProperty(document, 'currentScript', { value: null, configurable: true });
  }
};

/*
 * `Reflect.deleteProperty` rather than `delete`, and rather than assigning
 * `undefined`: assigning *creates* the key, so the "one global and no others"
 * case below would compare a set that already contains it against one that
 * does, and pass whatever the loader did.
 */
const forget = (): void => {
  Reflect.deleteProperty(globalThis, GLOBAL);
};

beforeEach(() => {
  forget();
  before = new Set(Object.keys(globalThis));
  document.body.replaceChildren();
});

afterEach(forget);

describe('what it mounts', () => {
  it('creates one host with an open shadow root and a launcher', () => {
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      const mounted = start();

      expect(mounted?.host.tagName.toLowerCase()).toBe(HOST_TAG);
      expect(mounted?.shadow.mode).toBe('open');
      expect(mounted?.launcher.tagName).toBe('BUTTON');
    });
  });

  it('attaches the host to the page', () => {
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      start();

      expect(document.body.querySelectorAll(HOST_TAG)).toHaveLength(1);
    });
  });

  it('gives the launcher a name a screen reader can announce', () => {
    // The button's text is an emoji, which a screen reader reads as "wine
    // glass" or as nothing at all depending on the reader.
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      const mounted = start();

      expect(mounted?.launcher.getAttribute('aria-label')).toBeTruthy();
      expect(mounted?.launcher.getAttribute('aria-haspopup')).toBe('dialog');
      expect(mounted?.launcher.getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('is a real button, so a keyboard reaches it', () => {
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      expect(start()?.launcher.type).toBe('button');
    });
  });

  it('builds the launcher from nodes, never from markup', () => {
    /*
     * An ESLint rule bans `innerHTML` in this package (§3.7, P3-08). This is
     * the behavioural half: the launcher has exactly one child of its own, the
     * text, and no parsed markup underneath it.
     */
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      const mounted = start();

      expect(mounted?.launcher.children).toHaveLength(0);
      expect(mounted?.launcher.textContent).not.toBe('');
    });
  });
});

describe('what it reads from the tag', () => {
  it('takes the key the seller pasted', () => {
    withScript({ 'data-key': 'pk_live_xyz' }, () => {
      start();

      expect(globalThis.__sommelier?.key).toBe('pk_live_xyz');
    });
  });

  it('takes an API origin when one is given, for a staging site', () => {
    withScript({ 'data-key': 'pk_test_abc', 'data-api': 'https://staging.example' }, () => {
      start();

      expect(globalThis.__sommelier?.api).toBe('https://staging.example');
    });
  });

  it('falls back to the API the seller does not have to know about', () => {
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      start();

      expect(globalThis.__sommelier?.api).toBe(DEFAULT_API);
    });
  });

  it('mounts nothing without a key', () => {
    // A snippet pasted without the key is a seller mid-setup. Doing nothing is
    // right; a launcher that opens and then fails is worse than no launcher.
    withScript({}, () => {
      expect(start()).toBeUndefined();
      expect(document.body.querySelectorAll(HOST_TAG)).toHaveLength(0);
    });
  });

  it('mounts nothing for an empty key', () => {
    withScript({ 'data-key': '' }, () => {
      expect(start()).toBeUndefined();
    });
  });
});

describe('what a storefront may choose (P6-09)', () => {
  /*
   * A theme's own settings, written as attributes on the tag: which corner, and
   * which colour. Both arrive from somebody else's page and one of them is
   * written into a stylesheet, so what is *not* accepted is most of this.
   */
  const globalFor = (attributes: Record<string, string>) => {
    let read: typeof globalThis.__sommelier;

    withScript({ 'data-key': 'pk_test_abc', ...attributes }, () => {
      start();
      read = globalThis.__sommelier;
    });
    forget();
    document.body.replaceChildren();

    return read;
  };

  /** Every rule the launcher was given, for a tag with these attributes. */
  const sheetFor = (attributes: Record<string, string>): string => {
    let text = '';

    withScript({ 'data-key': 'pk_test_abc', ...attributes }, () => {
      const adopted = start()?.shadow.adoptedStyleSheets as readonly CSSStyleSheet[] | undefined;

      text = [...(adopted ?? [])]
        .flatMap((one) => [...one.cssRules].map((rule) => rule.cssText))
        .join(String.fromCharCode(10));
    });
    forget();
    document.body.replaceChildren();

    return text;
  };

  it('is the name the theme extension writes for the other corner', () => {
    /* `packages/core`'s `theme-extension.test.ts` pins the same word on the Liquid side. */
    expect(LEFT).toBe('bottom-left');
  });

  it('takes the left corner when asked, and draws the launcher there from the start', () => {
    expect(globalFor({ 'data-position': 'bottom-left' })?.position).toBe('bottom-left');

    const sheet = sheetFor({ 'data-position': 'bottom-left' });

    expect(sheet).toMatch(/button\[part=.launcher.\] \{[^}]*left: 20px/u);
    expect(sheet).toMatch(/button\[part=.launcher.\] \{[^}]*right: auto/u);
  });

  it.each(['bottom-right', 'top-left', 'left', 'BOTTOM-LEFT', ''])(
    'stays in the right corner for %j: only the one alternative is a choice',
    (position) => {
      expect(globalFor({ 'data-position': position })?.position).toBeUndefined();
      expect(sheetFor({ 'data-position': position })).not.toContain('left: 20px');
    },
  );

  it('stays in the right corner when nothing is said, exactly as before', () => {
    expect(globalFor({})?.position).toBeUndefined();
    expect(globalFor({})?.color).toBeUndefined();
    expect(sheetFor({})).toBe(sheetFor({ 'data-position': 'bottom-right' }));
  });

  it('takes a colour a theme’s picker would write, and puts it on the launcher', () => {
    expect(globalFor({ 'data-color': '#1f6f4a' })?.color).toBe('#1f6f4a');
    expect(globalFor({ 'data-color': '#1F6F4A' })?.color).toBe('#1F6F4A');
    expect(sheetFor({ 'data-color': '#1f6f4a' })).toMatch(
      /button\[part=.launcher.\] \{[^}]*background: (#1f6f4a|rgb\(31, 111, 74\))/u,
    );
  });

  it.each([
    ['a name', 'red'],
    ['three digits', '#fff'],
    ['eight digits', '#1f6f4aff'],
    ['a function', 'rgb(31, 111, 74)'],
    ['a rule closed and another opened', '#1f6f4a; } * { display: none'],
    ['a url', 'url(https://evil.example/x)'],
    ['nothing', ''],
  ])('takes no colour from %s, and writes nothing of it into the sheet', (_, color) => {
    /* The value is concatenated into stylesheet text: six hex digits cannot close a rule. */
    expect(globalFor({ 'data-color': color })?.color).toBeUndefined();

    const sheet = sheetFor({ 'data-color': color });

    expect(sheet).toBe(sheetFor({}));
    expect(sheet).not.toContain('display: none');
    expect(sheet).not.toContain('evil.example');
  });

  it('keeps the first tag’s choices when the snippet is pasted twice', () => {
    withScript({ 'data-key': 'pk_test_abc', 'data-position': 'bottom-left' }, () => {
      start();
    });
    withScript({ 'data-key': 'pk_test_abc', 'data-color': '#1f6f4a' }, () => {
      start();
    });

    expect(globalThis.__sommelier?.position).toBe('bottom-left');
    expect(globalThis.__sommelier?.color).toBeUndefined();
  });
});

describe('a snippet pasted twice', () => {
  it('creates exactly one host', () => {
    /*
     * A seller who puts the snippet in a header partial *and* a page template
     * gets two copies. Two launchers is a visible bug on their storefront, and
     * the fix has to hold when both run in the same tick.
     */
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      start();
      start();

      expect(document.body.querySelectorAll(HOST_TAG)).toHaveLength(1);
    });
  });

  it('answers the second call with nothing', () => {
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      start();

      expect(start()).toBeUndefined();
    });
  });

  it('keeps the first key, not the second', () => {
    // Two snippets with different keys is a mistake, and picking the later one
    // would silently point the widget at whichever tag happened to be last.
    withScript({ 'data-key': 'pk_first' }, () => {
      start();
    });
    withScript({ 'data-key': 'pk_second' }, () => {
      start();
    });

    expect(globalThis.__sommelier?.key).toBe('pk_first');
  });
});

describe('what it leaves alone', () => {
  it('defines one global and no others', () => {
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      start();
    });

    const added = Object.keys(globalThis).filter((name) => !before.has(name));

    expect(added).toEqual([GLOBAL]);
  });

  it('adds nothing to the page but the host', () => {
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      start();
    });

    expect([...document.body.children].map((child) => child.tagName.toLowerCase())).toEqual([
      HOST_TAG,
    ]);
  });

  it('keeps its styles inside the shadow root', () => {
    // A `<style>` in the document would be ours applying to a seller's page.
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      const mounted = start();

      expect(document.head.querySelector('style')).toBeNull();
      expect(mounted?.shadow.adoptedStyleSheets).not.toHaveLength(0);
    });
  });

  it('adopts rather than injecting, so no CSP exception is needed', () => {
    /*
     * **A `<style>` element is governed by `style-src` wherever it is
     * created** (P3-18). The element form asks every seller running a strict
     * policy for `'unsafe-inline'`, and a seller with a payment form on the
     * same page is the one least willing to give it. A constructed stylesheet
     * is a script operation, covered by the `script-src` they already allow.
     */
    withScript({ 'data-key': 'pk_test_abc' }, () => {
      const mounted = start();

      expect(mounted?.shadow.querySelectorAll('style')).toHaveLength(0);
    });
  });
});

describe('when something goes wrong', () => {
  it('never throws into the storefront', () => {
    /*
     * **The failure that ends a subscription rather than opening a ticket.** A
     * document with no body is one way to get here; a browser without
     * `attachShadow` is another. Either way the shop keeps working and the
     * widget does not appear, which is the right way round.
     */
    globalThis.__sommelier = { key: 'pk_test_abc', api: DEFAULT_API, mounted: false };

    const broken = {
      createElement: () => {
        throw new Error('this page is not what you think it is');
      },
    } as unknown as Document;

    expect(() => start({ document: broken })).not.toThrow();
    expect(start({ document: broken })).toBeUndefined();
  });

  it('mounts nothing when the global was never set', () => {
    // `mount` is exported for the bundle that comes later, and calling it
    // before `start` is a wiring mistake rather than a visitor's problem.
    expect(mount()).toBeUndefined();
  });
});

describe('what the launcher does when it is used', () => {
  it('runs the press behaviour on a click', () => {
    const launcher = document.createElement('button');
    const onPress = vi.fn();

    attach(launcher, { onPress });
    launcher.click();

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('runs the hover behaviour on pointerenter, separately', () => {
    /*
     * A visitor who hovers has not asked for anything. The hint is a separate
     * listener because P3-04's preload must never be what makes the widget
     * work — the click has to stand on its own.
     */
    const launcher = document.createElement('button');
    const onPress = vi.fn();
    const onHover = vi.fn();

    attach(launcher, { onPress, onHover });
    launcher.dispatchEvent(new Event('pointerenter'));

    expect(onHover).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('wires no hover listener when there is nothing to hint at', () => {
    const launcher = document.createElement('button');
    const onPress = vi.fn();

    attach(launcher, { onPress });

    expect(() => launcher.dispatchEvent(new Event('pointerenter'))).not.toThrow();
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('the stylesheet it injects', () => {
  /*
   * **Both of these shipped, and only a browser caught them** (P3-18). JSDOM
   * applies no CSS, so nothing in this file could have — but a stylesheet is a
   * string, and asserting on the string is cheap insurance against the same
   * mistake being made again by somebody who never runs the browser suite.
   */
  /** Every rule in the root, adopted or appended — P3-18 made it the former. */
  const sheet = (): string => {
    let text = '';

    withScript({ 'data-key': 'pk_test_abc' }, () => {
      const mounted = start();
      const adopted = mounted?.shadow.adoptedStyleSheets as readonly CSSStyleSheet[] | undefined;

      text = [
        ...[...(adopted ?? [])].map((one) =>
          [...one.cssRules].map((rule) => rule.cssText).join(String.fromCharCode(10)),
        ),
        ...[...(mounted?.shadow.querySelectorAll('style') ?? [])].map(
          (node) => node.textContent ?? '',
        ),
      ].join(String.fromCharCode(10));
    });

    return text;
  };

  it('injects one at all, so the assertions below are not vacuous', () => {
    expect(sheet()).toContain('button');
  });

  it('scopes every rule to the launcher', () => {
    /*
     * A bare `button` selector reaches the panel too: the composer, the cards
     * and the retry all live in this same shadow root, and every one of them
     * rendered as a 56px circle pinned to the bottom-right corner.
     */
    for (const rule of sheet().split('}')) {
      const selector = rule.split('{')[0]?.trim() ?? '';

      if (!selector.includes('button')) continue;

      expect(selector, selector).toContain("part='launcher'");
    }
  });

  it('claims the corner for the launcher and nothing else', () => {
    const fixed = sheet()
      .split('}')
      .filter((rule) => rule.includes('position: fixed'));

    expect(fixed).not.toHaveLength(0);

    for (const rule of fixed) {
      expect(rule, rule).toContain("part='launcher'");
    }
  });
});

describe('finding its own tag', () => {
  /*
   * **`document.currentScript` is null in a module script**, always, and the
   * loader ships as one: `type="module"` is what makes `import()` resolve the
   * widget chunk against the bundle's own URL rather than the shop's document
   * base, and a classic script cannot use `import.meta` at all.
   *
   * As shipped before P3-18, the built loader threw
   * `Cannot use 'import.meta' outside a module` on every storefront while every
   * test here passed — because these call `start()` rather than loading the
   * bundle in a browser.
   */
  it('falls back to the tag carrying the key', () => {
    const script = document.createElement('script');

    script.setAttribute('data-key', 'pk_test_abc');
    script.setAttribute('data-api', 'https://api.example');
    document.head.append(script);

    /* No `currentScript`, exactly as a module script sees it. */
    Object.defineProperty(document, 'currentScript', { value: null, configurable: true });

    try {
      expect(start()).toBeDefined();
      expect(globalThis.__sommelier?.key).toBe('pk_test_abc');
      expect(globalThis.__sommelier?.api).toBe('https://api.example');
    } finally {
      script.remove();
    }
  });

  it('still prefers currentScript when there is one', () => {
    /* Exact when it works, and two tags on a page is a thing that happens. */
    const other = document.createElement('script');

    other.setAttribute('data-key', 'pk_test_wrong');
    document.head.append(other);

    try {
      withScript({ 'data-key': 'pk_test_right' }, () => {
        start();
      });

      expect(globalThis.__sommelier?.key).toBe('pk_test_right');
    } finally {
      other.remove();
    }
  });

  it('mounts nothing when no tag carries a key', () => {
    Object.defineProperty(document, 'currentScript', { value: null, configurable: true });

    expect(start()).toBeUndefined();
  });
});
