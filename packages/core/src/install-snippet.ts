/**
 * The tag a seller pastes into their storefront, and where it loads from
 * (P4-08, P6-09).
 *
 * **Its own file, and it imports nothing**, so the dashboard's Widget screen
 * (P4-09b) builds the very tag the theme extension is held to rather than a
 * copy — `browser-subpaths.test.ts` keeps it that way.
 */

/** The characters that end or escape an HTML attribute value. */
const ATTRIBUTE_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '"': '&quot;',
  '<': '&lt;',
  '>': '&gt;',
};

const attribute = (value: string): string =>
  value.replace(/[&"<>]/gu, (character) => ATTRIBUTE_ESCAPES[character] ?? character);

/**
 * The tag a seller pastes into their storefront (P4-08).
 *
 * **One definition, so the key shown and the key in the snippet cannot
 * disagree.** A rotation screen that showed the new key and a snippet built
 * somewhere else from a stale value would have a seller redeploy the key they
 * were rotating away from — and find out when the grace window closed.
 *
 * `type="module"` because the loader is one (P3-18): a classic script tag
 * throws on the `import.meta` Vite's preload helper uses. Both values are
 * attribute-escaped even though a public key is base62: this is markup we tell
 * somebody to paste into their own site, and it is correct regardless of what
 * is put in it.
 */
/**
 * Where the loader is served in production (P6-09): the distribution that
 * answers the API, at the path it keeps for the bundle (§5.1).
 *
 * Named once because two things write it into a storefront — the snippet a
 * seller pastes, and the Shopify theme extension, which is a Liquid file and
 * cannot import anything. `theme-extension.test.ts` reads that file and holds
 * it to this value.
 */
export const LOADER_SRC = 'https://api.catalogorosso.com/v1/w.js';

export const installSnippet = (publicKey: string, loaderSrc: string): string =>
  `<script type="module" src="${attribute(loaderSrc)}" data-key="${attribute(publicKey)}" async></script>`;
