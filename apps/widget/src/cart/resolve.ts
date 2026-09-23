/**
 * Which cart this storefront has (P3-10, §1.6).
 *
 * **A pure function, decided at runtime on somebody else's page.** No fetch, no
 * DOM writes, no listeners — which is what makes every branch a plain
 * assertion, and that matters more here than almost anywhere else: we cannot
 * test on every customer site, so the only thing standing between us and a shop
 * where the button does nothing is a table of cases.
 *
 * **The seller's explicit choice beats our detection.** A Shopify store that
 * has also implemented `window.__sommelierCart` has done so on purpose,
 * probably because their theme does something ours would break.
 */

/** What a seller implements to take a wine from us (§1.6). Validated before it is called. */
export interface SommelierCart {
  readonly addToCart: (item: { productId: string; quantity: number }) => Promise<void> | void;
  readonly getCount: () => number | Promise<number>;
}

export type CartAdapter =
  /** The seller's own object on `window`. */
  | { readonly k: 'generic'; readonly cart: SommelierCart }
  /** The seller listens for `sommelier:add-to-cart` and acks it. */
  | { readonly k: 'event' }
  /** A Shopify storefront, using its own AJAX cart. */
  | { readonly k: 'shopify' }
  /** Nothing we can add to. The card degrades to "Vedi prodotto" (§1.6). */
  | { readonly k: 'none' };

/**
 * What a seller may write on the script tag to settle it themselves.
 *
 * **The event contract cannot be detected** *(deviation from §1.6)*. There is
 * no API that answers "does anything listen for this event", so a widget that
 * claimed to detect it would be dispatching one and waiting — a side effect, in
 * a resolver the row requires to be pure, on a page that may have no listener
 * at all. Declaring it is one attribute beside `data-key`, and it is the same
 * seller making the same kind of choice.
 */
export const CART_MODES = ['shopify', 'generic', 'event', 'none'] as const;

export type CartMode = (typeof CART_MODES)[number];

/**
 * Whether a value is the contract rather than something else called the same.
 *
 * **Validated before it is called, never after** (P3-12). A seller's
 * half-implementation — an `addToCart` they meant to write, a `getCount` they
 * renamed — must degrade to "Vedi prodotto" rather than throw inside their own
 * page, where our name is on the stack trace.
 */
export const isSommelierCart = (value: unknown): value is SommelierCart => {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as { addToCart?: unknown; getCount?: unknown };

  return typeof candidate.addToCart === 'function' && typeof candidate.getCount === 'function';
};

/** The bits of a host page this reads. Narrow, so a test can supply all of it. */
export interface HostPage {
  readonly __sommelierCart?: unknown;
  readonly Shopify?: unknown;
}

export interface ResolveOptions {
  readonly host: HostPage;
  /** `data-cart` from the seller's script tag, when they wrote one. */
  readonly declared?: string | undefined;
}

/**
 * Picks the adapter for this page.
 *
 * Order, and each step has a reason:
 *
 * 1. **A declared mode wins**, because a seller who wrote it down knows their
 *    theme better than our sniffing does.
 * 2. **`window.__sommelierCart`**, if it is really the contract. §1.6 calls
 *    this the generic adapter and it is the seller's own code.
 * 3. **`window.Shopify`**, which every Shopify storefront theme sets.
 * 4. **Nothing**, and the card shows "Vedi prodotto" instead.
 *
 * A declared `generic` with no valid object on `window` falls through rather
 * than failing: the seller said what they meant and got it wrong, and the
 * degraded card is still a working card.
 */
export const resolveCart = ({ host, declared }: ResolveOptions): CartAdapter => {
  const generic = isSommelierCart(host.__sommelierCart)
    ? ({ k: 'generic', cart: host.__sommelierCart } as const)
    : undefined;

  /*
   * Compared directly rather than through a `CART_MODES` guard first: the tests
   * below *are* the guard, and a separate one added nothing a mutation could
   * see. A word nobody defined matches none of them and falls through to
   * detection, which is the right answer for a typo.
   *
   * **`generic` is accepted and does nothing**, which the seller documentation
   * says too: if the object is on `window` the step below finds it, and if it
   * is not, saying so cannot conjure it. A branch for it read as a decision and
   * was provably dead — mutation testing is what showed that removing it
   * changed no outcome at all.
   */
  if (declared === 'event') return { k: 'event' };
  if (declared === 'shopify') return { k: 'shopify' };
  if (declared === 'none') return { k: 'none' };

  if (generic !== undefined) return generic;

  /* Every Shopify theme sets this. A headless storefront does not, which is
   * what `data-cart="shopify"` above is for. */
  if (typeof host.Shopify === 'object' && host.Shopify !== null) return { k: 'shopify' };

  return { k: 'none' };
};
