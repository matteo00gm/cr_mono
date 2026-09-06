/**
 * The one place an email body is built (P0-64).
 *
 * Templates return a small block list rather than strings, and this module
 * turns that into both an HTML part and a plaintext part. Two consequences,
 * both of them the reason for the indirection:
 *
 * 1. **Escaping happens once.** Template props carry tenant names, inviter
 *    names and domains — all seller-supplied. A winery that names itself
 *    `<img onerror=…>` must not get that rendered into mail we send on its
 *    behalf. Escaping in each template would mean six chances to forget.
 * 2. **A plaintext part cannot be omitted**, because no template is capable of
 *    producing only HTML. HTML-only mail scores worse with spam filters, and
 *    doing that on account-recovery messages is a deliberate own-goal.
 */

/** The whole vocabulary. Deliberately small — this is transactional mail. */
export type Block =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'action'; readonly label: string; readonly url: string }
  /** Small print: expiry warnings, "if you did not request this". */
  | { readonly kind: 'note'; readonly value: string };

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export class UnsafeEmailUrlError extends Error {
  constructor(url: string) {
    super(
      `Refusing to put "${url}" in an email: only http and https are allowed. ` +
        'A link scheme in an email is attacker-reachable through whatever composed ' +
        'the URL, and `javascript:` in an href is the classic result.',
    );
    this.name = 'UnsafeEmailUrlError';
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * `&` first is not an ordering preference, it is the correctness condition:
 * replacing it after the others would double-escape their output into
 * `&amp;lt;`. Done with a single pass so the ordering cannot be got wrong.
 */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);

/**
 * Validates the scheme, then escapes.
 *
 * Both, in that order. Escaping alone would render `javascript:alert(1)`
 * harmlessly as text but happily place it in an `href`, where the escaping does
 * nothing at all — the quotes are already fine; the scheme is the problem.
 */
const safeUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeEmailUrlError(url);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UnsafeEmailUrlError(url);
  }

  return escapeHtml(parsed.toString());
};

/*
 * Inline styles, and no stylesheet.
 *
 * Not a style preference: Gmail strips `<style>` blocks from the head, and a
 * large share of clients ignore anything not inlined. This is the one place in
 * the repository where inline styles are the correct answer rather than a
 * shortcut.
 */
const BODY_STYLE =
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
  'font-size:16px;line-height:1.5;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px';
const ACTION_STYLE =
  'display:inline-block;background:#7f1d1d;color:#ffffff;text-decoration:none;' +
  'padding:12px 20px;border-radius:6px;font-weight:600';
const NOTE_STYLE = 'font-size:14px;color:#666666';

const htmlBlock = (block: Block): string => {
  switch (block.kind) {
    case 'text':
      return `<p>${escapeHtml(block.value)}</p>`;
    case 'action':
      return `<p><a href="${safeUrl(block.url)}" style="${ACTION_STYLE}">${escapeHtml(block.label)}</a></p>`;
    case 'note':
      return `<p style="${NOTE_STYLE}">${escapeHtml(block.value)}</p>`;
  }
};

const textBlock = (block: Block): string => {
  switch (block.kind) {
    case 'text':
    case 'note':
      return block.value;
    case 'action':
      /*
       * The URL in full, on its own line. A plaintext part that says "click
       * here" is useless, and it is exactly the reader on a text-only client or
       * a screen reader who most needs the link to be readable.
       */
      return `${block.label}:\n${safeUrl(block.url).replace(/&amp;/g, '&')}`;
  }
};

export const render = (
  subject: string,
  blocks: readonly Block[],
  locale: string,
): RenderedEmail => ({
  subject,
  /*
   * `lang` is not decoration. A screen reader picks its voice from this
   * attribute, and Italian read aloud by an English voice is close to
   * unintelligible — which matters most on the password-reset mail, the one
   * someone locked out of their account has to get through.
   */
  html:
    `<!doctype html><html lang="${escapeHtml(locale)}"><body style="${BODY_STYLE}">` +
    blocks.map(htmlBlock).join('') +
    '</body></html>',
  text: blocks.map(textBlock).join('\n\n') + '\n',
});
