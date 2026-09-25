/**
 * Putting a stylesheet in a shadow root without asking for a CSP exception
 * (P3-18, §1.1).
 *
 * **A `<style>` element is governed by `style-src`, wherever it is created.**
 * That is not obvious — the element never appears in the seller's HTML, and the
 * shadow root scopes it away from their page — but CSP does not care how a
 * style got there. So a widget that builds its stylesheet that way requires
 * every seller running a strict policy to add `'unsafe-inline'` to `style-src`,
 * and a seller with a payment form on the same page is exactly the seller least
 * willing to. It is the kind of requirement that loses a deal quietly.
 *
 * **A constructed stylesheet is not.** `CSSStyleSheet` + `adoptedStyleSheets`
 * is a script operation, covered by `script-src`, which they are already
 * allowing in order to run us at all. Same bytes, same scoping, no exception.
 *
 * P3-17's hostile page is where this is proved: it serves `style-src 'self'`
 * with no `'unsafe-inline'`, and the widget has to look right under it.
 *
 * **Imported by the loader only, and handed to the panel as a function.** Both
 * bundles need it, and a module imported by both is a module Rollup hoists into
 * a chunk the loader statically imports — which is the collapse P3-05's budget
 * check refuses, and which it caught the moment this file was shared. The same
 * shape as `attach` (P3-04): handed in rather than imported.
 */

/** What the panel is given, so it never imports this module. */
export type AdoptStyles = (shadow: ShadowRoot, css: string, document_: Document) => void;

/**
 * Adopts a stylesheet into a shadow root, falling back to a `<style>` element.
 *
 * **The fallback is not dead code.** `adoptedStyleSheets` is a setter on Safari
 * 16.4 and newer, and older Safari is a real share of Italian storefront
 * traffic. On those, a `<style>` element is what there is — and a seller on a
 * strict CSP *and* an old browser gets an unstyled widget rather than a broken
 * page, which is the right way round.
 *
 * Returns nothing: the caller has a shadow root and wanted it styled, and there
 * is no failure it could usefully act on.
 */
export const adoptStyles: AdoptStyles = (shadow, css, document_) => {
  /*
   * **Detected by trying it and reading it back**, not by `'adoptedStyleSheets'
   * in shadow`. That property test is false in JSDOM on a root that has never
   * been assigned one, while the assignment itself works perfectly — so the
   * obvious check sends the whole test suite down the fallback path and proves
   * nothing about the path that ships. Asking whether it *took* is the only
   * question with a reliable answer.
   */
  try {
    const sheet = new CSSStyleSheet();

    sheet.replaceSync(css);

    /*
     * Appended rather than assigned: the launcher and the panel each adopt
     * their own, and the second must not replace the first.
     *
     * Read through a widened local because the property is *undefined* on a
     * root nothing has adopted into yet — the DOM lib types it as always an
     * array, and JSDOM disagrees. Spreading it directly threw, which sent every
     * mount down the fallback path with nothing failing.
     */
    const adopted = shadow.adoptedStyleSheets as readonly CSSStyleSheet[] | undefined;

    shadow.adoptedStyleSheets = [...(adopted ?? []), sheet];

    if (shadow.adoptedStyleSheets.includes(sheet)) return;
  } catch {
    /*
     * `new CSSStyleSheet()` throws on Safari before 16.4, `replaceSync` throws
     * on an `@import`, and a flag can remove either. None is worth breaking a
     * storefront over.
     */
  }

  const style = document_.createElement('style');

  style.textContent = css;
  shadow.append(style);
};
