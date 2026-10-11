import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { installSnippet, LOADER_SRC } from '../src/domains.js';

/**
 * The Shopify theme extension, held to the snippet it replaces (P6-09).
 *
 * **A Liquid file cannot import anything**, so the tag it renders is written
 * out by hand — the loader's address, the key's attribute, `type="module"` —
 * and nothing but this file stops it drifting from the tag `installSnippet`
 * writes for a seller who pastes it themselves. A storefront that installs the
 * app and one that edits its theme have to get the same widget.
 *
 * Read as text, because that is what it is until Shopify renders it; the
 * render itself is verified by hand on a development store.
 */

const LIQUID = readFileSync(
  fileURLToPath(
    new URL('../../../extensions/sommelier-widget/blocks/sommelier.liquid', import.meta.url),
  ),
  'utf8',
);

/** Built at runtime, never written down (P0-56). */
const KEY = ['pk', 'test', 'a'.repeat(12)].join('_');

/** The one `<script>` tag the block renders, as Liquid wrote it. */
const tag = (): string => {
  const found = /<script[\s\S]*?<\/script>/u.exec(LIQUID)?.[0];

  if (found === undefined) throw new Error('The block renders no script tag.');

  return found;
};

/** A tag's attributes: `name="value"`, and the bare ones as `true`. */
const attributesOf = (markup: string): Record<string, string | true> => {
  const inside = /^<script([\s\S]*?)>/u.exec(markup)?.[1] ?? '';
  const withoutLiquid = inside.replaceAll(/\{%-?[\s\S]*?-?%\}/gu, ' ');
  const attributes: Record<string, string | true> = {};

  for (const match of withoutLiquid.matchAll(/([a-z-]+)(?:="([^"]*)")?/giu)) {
    const [, name, value] = match;

    if (name !== undefined) attributes[name] = value ?? true;
  }

  return attributes;
};

/** The block's tag as Shopify would render it for a key, with nothing else chosen. */
const rendered = (key: string): Record<string, string | true> =>
  attributesOf(tag().replaceAll('{{ public_key | escape }}', key));

const schema = (): {
  target: string;
  settings: { type: string; id: string; default?: string; options?: { value: string }[] }[];
} => {
  const json = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/u.exec(LIQUID)?.[1];

  if (json === undefined) throw new Error('The block has no schema.');

  return JSON.parse(json) as ReturnType<typeof schema>;
};

describe('the tag the extension renders', () => {
  it('loads the loader the snippet loads', () => {
    expect(rendered(KEY).src).toBe(LOADER_SRC);
  });

  it('is the snippet’s tag, attribute for attribute, with the theme’s choices beside it', () => {
    const snippet = attributesOf(installSnippet(KEY, LOADER_SRC));
    const block = rendered(KEY);

    /* `type="module"` and `async` matter as much as the address (P3-18). */
    expect(snippet).toEqual({ type: 'module', src: LOADER_SRC, 'data-key': KEY, async: true });

    for (const [name, value] of Object.entries(snippet)) {
      expect(block[name], name).toBe(value);
    }

    expect(Object.keys(block).sort()).toEqual(
      [...Object.keys(snippet), 'data-color', 'data-position'].sort(),
    );
  });

  it('escapes everything it writes into the storefront', () => {
    /* Markup rendered into somebody's shop, from values a person typed into a theme editor. */
    const outputs = [...tag().matchAll(/\{\{([\s\S]*?)\}\}/gu)].map(([, output]) => output ?? '');

    expect(outputs.length).toBeGreaterThanOrEqual(3);

    for (const output of outputs) {
      expect(output, output).toMatch(/\|\s*escape\s*$/u);
    }
  });

  it('renders nothing at all without a key', () => {
    /* An embed switched on and never filled in is a shop without a widget, not a broken one. */
    const guard = LIQUID.indexOf('{%- if public_key != blank -%}');
    const closing = LIQUID.lastIndexOf('{%- endif -%}');

    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(LIQUID.indexOf('<script'));
    expect(closing).toBeGreaterThan(LIQUID.indexOf('</script>'));
    expect(LIQUID).toContain('assign public_key = block.settings.public_key | strip');
  });

  it('writes a colour only when one was chosen', () => {
    expect(tag()).toMatch(
      /\{%-? if block\.settings\.color != blank %\}\s*data-color="\{\{ block\.settings\.color \| escape \}\}"\s*\{%-? endif %\}/u,
    );
  });
});

describe('what the theme editor offers', () => {
  it('is an app embed on the page’s body, so no section has to be placed', () => {
    expect(schema().target).toBe('body');
  });

  it('asks for the key, a corner and a colour, and nothing else', () => {
    expect(schema().settings.map(({ id, type }) => [id, type])).toEqual([
      ['public_key', 'text'],
      ['position', 'select'],
      ['color', 'color'],
    ]);
  });

  it('offers the two corners the widget knows, under the names it reads', () => {
    /* `bottom-left` is the one value the loader acts on; anything else is the right corner. */
    const position = schema().settings.find(({ id }) => id === 'position');

    expect(position?.options?.map(({ value }) => value)).toEqual(['bottom-right', 'bottom-left']);
    expect(position?.default).toBe('bottom-right');
  });

  it('chooses no colour by default, so the winery’s own stands', () => {
    expect(schema().settings.find(({ id }) => id === 'color')?.default).toBeUndefined();
  });
});
