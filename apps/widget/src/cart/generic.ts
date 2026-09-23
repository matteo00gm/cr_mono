import type { SommelierCart } from './resolve.js';

/**
 * The contract a seller on a proprietary site implements (P3-12, §1.6).
 *
 * Two shapes, because two kinds of site exist. A seller with a JavaScript cart
 * sets an object on `window`; a seller whose cart lives behind a framework
 * they would rather not expose listens for an event and acks it.
 *
 * **Their code runs inside ours, so none of it is trusted to behave.** It may
 * throw, it may return something that is not a promise, it may hang forever
 * because their endpoint is down. Each of those has to end as a shopper being
 * told we could not add the wine — never as an exception in the seller's own
 * console with our name on the stack trace.
 */

/** The event the widget dispatches, and the one it waits for. Documented in `docs/`. */
export const ADD_EVENT = 'sommelier:add-to-cart';
export const ACK_EVENT = 'sommelier:cart-updated';

/** Long enough for a slow endpoint, short enough that a shopper does not give up. */
export const ACK_TIMEOUT_MS = 5000;

export interface AddRequest {
  readonly productId: string;
  readonly quantity: number;
}

/**
 * Bounds a promise that belongs to somebody else.
 *
 * A seller's implementation may never settle — an endpoint that is down, an
 * `await` on something that never resolves. Without this the shopper watches a
 * spinner until they close the tab.
 */
const withTimeout = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Il carrello del negozio non ha risposto.'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    /* Cleared whichever side won: a timer left running keeps the page awake and
     * its rejection would arrive with nobody listening. */
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * Calls the seller's own object.
 *
 * **Wrapped and timed out.** `addToCart` is their code: a synchronous throw, a
 * rejected promise and a promise that never settles are all things it does, and
 * all three have to look the same to the caller.
 */
export const addViaObject = async (
  cart: SommelierCart,
  item: AddRequest,
  timeoutMs = ACK_TIMEOUT_MS,
): Promise<void> => {
  /* `Promise.resolve` accepts a seller who returned nothing; the surrounding
   * `async` is what turns their synchronous throw into a rejection. */
  await withTimeout(Promise.resolve(cart.addToCart(item)), timeoutMs);
};

/**
 * Reads the seller's count, or nothing.
 *
 * A count is a nicety. If theirs throws or answers something that is not a
 * number, the badge is absent rather than the widget broken.
 */
export const countViaObject = async (cart: SommelierCart): Promise<number | undefined> => {
  try {
    const count = await cart.getCount();

    return typeof count === 'number' && Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Dispatches the event and waits for the ack.
 *
 * **The ack is what makes this a contract rather than a hope.** Without one,
 * every add looks like a success and a shopper watches a button say "aggiunto"
 * over a cart that never changed. A seller who listens and does not ack gets
 * the timeout, which is the same outcome as not listening at all — correct,
 * because from here those two are the same thing.
 *
 * `detail.ok === false` is a refusal the seller reports deliberately, which is
 * told apart from silence: one is their cart saying no, the other is their page
 * saying nothing.
 */
export const addViaEvent = async (
  item: AddRequest,
  {
    target = document,
    timeoutMs = ACK_TIMEOUT_MS,
  }: { target?: EventTarget; timeoutMs?: number } = {},
): Promise<void> => {
  let stopListening = (): void => undefined;

  const acked = new Promise<void>((resolve, reject) => {
    const listener = (event: Event): void => {
      /*
       * The seller builds this event, so `detail` is whatever they put in it —
       * including nothing at all. Read as `unknown` and narrowed, not trusted.
       */
      const detail = (event as CustomEvent<unknown>).detail as
        { productId?: unknown; ok?: unknown } | null | undefined;
      const ackedId = detail?.productId;

      /* An ack for another line is not this line's ack. */
      if (typeof ackedId === 'string' && ackedId !== item.productId) return;

      if (detail?.ok === false) reject(new Error('Il negozio non ha aggiunto il vino.'));
      else resolve();
    };

    stopListening = () => {
      target.removeEventListener(ACK_EVENT, listener);
    };

    target.addEventListener(ACK_EVENT, listener);
  });

  target.dispatchEvent(new CustomEvent(ADD_EVENT, { detail: item }));

  try {
    await withTimeout(acked, timeoutMs);
  } finally {
    /*
     * **Removed however it ended, including the timeout.** A seller who never
     * acks leaves one listener per add on their `document`, for as long as the
     * visitor stays on the page — and every one of them still holds a promise
     * nobody will ever settle.
     */
    stopListening();
  }
};
