/**
 * Keyboard focus while the panel is open (P3-15, §1.7).
 *
 * **A plain function, not a hook** *(deviation from the row's `useFocusTrap.ts`)*.
 * The panel is imperative DOM built by `panel.ts` — it is opened and closed by
 * the launcher rather than by a render — and the trap has to cover the header
 * and the composer alike. A hook would have meant making the frame a component
 * to hold it, which is a larger change than the thing it would be holding.
 *
 * **Trapping is the modal pattern, and `Escape` is what makes it bearable.** A
 * widget that captured a shopper's keyboard with no way out would be worse than
 * one with no trap at all — which is why `aria-modal` only becomes true when
 * this is active, and why the close is wired before the trap is.
 */

/**
 * Everything a keyboard can reach, in document order.
 *
 * Deliberately not exhaustive: `contenteditable`, `audio[controls]` and the
 * rest exist and the panel contains none of them. A list that covers what is
 * actually rendered is one a reader can check.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export const focusableIn = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    /*
     * A control inside a hidden subtree is not reachable and must not be what
     * `Tab` wraps onto.
     *
     * **Checked by the attribute, not by layout.** `offsetParent` is the
     * obvious test and it is wrong twice over: it is null for every
     * `position: fixed` element, which the panel is, and JSDOM computes no
     * layout at all, so a suite written against it would pass while the trap
     * found nothing on a real page.
     */
    (element) => element.closest('[hidden]') === null,
  );

export interface TrapOptions {
  /** Called on `Escape`. The caller closes the panel; the trap does not. */
  readonly onEscape: () => void;
  /** Where focus goes when the trap is released. The launcher, in practice. */
  readonly returnTo?: HTMLElement | undefined;
}

export interface FocusTrap {
  /** Stops trapping and returns focus. Safe to call twice. */
  readonly release: () => void;
}

/**
 * Traps `Tab` inside an element until it is released.
 *
 * **Focus moves in on entry and back out on release**, because a dialog that
 * opens without taking focus is one a screen-reader user does not know is
 * there, and one that closes without giving it back leaves them at the top of
 * the shop with no idea why.
 */
export const trapFocus = (element: HTMLElement, { onEscape, returnTo }: TrapOptions): FocusTrap => {
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape();

      return;
    }

    if (event.key !== 'Tab') return;

    const focusable = focusableIn(element);
    const first = focusable[0];
    const last = focusable.at(-1);

    /* Nothing to trap. Letting `Tab` through beats swallowing it. */
    if (first === undefined || last === undefined) return;

    const active = element.getRootNode() as ShadowRoot | Document;
    const current = active.activeElement;

    if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  element.addEventListener('keydown', onKeydown);

  /*
   * The composer, when there is one: a visitor who opened the chat wants to
   * type, and landing them on the close button would make them tab past it.
   */
  const entry = element.querySelector<HTMLElement>('.composer-input') ?? focusableIn(element)[0];

  entry?.focus();

  let released = false;

  return {
    release: () => {
      if (released) return;

      released = true;
      element.removeEventListener('keydown', onKeydown);
      returnTo?.focus();
    },
  };
};
