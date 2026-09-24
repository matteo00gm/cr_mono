import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACK_EVENT,
  ADD_EVENT,
  addViaEvent,
  addViaObject,
  countViaObject,
} from '../src/cart/generic.js';
import { createCartPort, VariantMissing } from '../src/cart/port.js';
import type { SommelierCart } from '../src/cart/resolve.js';
import {
  addToShopifyCart,
  ADD_PATH,
  CART_PATH,
  SESSION_PROPERTY,
  ShopifyRefused,
  shopifyCartCount,
} from '../src/cart/shopify.js';

/**
 * Adding a wine to somebody else's cart (P3-11, P3-12, §1.6).
 *
 * **Two of these adapters are the seller's own code**, and none of it is
 * trusted to behave: it may throw, it may return something that is not a
 * promise, it may hang because their endpoint is down. Every one of those has
 * to end as a shopper being told we could not add the wine — never as an
 * exception inside their page with our name on the stack trace.
 */

const SESSION = 'sess-1';
const ITEM = { productId: 'p1', quantity: 1 } as const;

afterEach(() => {
  vi.useRealTimers();
});

/** The JSON body a call was sent, typed rather than stringified. */
const bodyOf = (fetch_: ReturnType<typeof responding>): unknown => {
  const body = fetch_.mock.calls[0]?.[1]?.body;

  /* `RequestInit['body']` is a union wide enough to include a stream. We always
   * send a string, and asserting that is cheaper than parsing a maybe. */
  if (typeof body !== 'string') throw new Error('The call did not carry a JSON body.');

  return JSON.parse(body);
};

const responding = (init: ResponseInit, body: unknown = {}) =>
  vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        ...init,
      }),
    ),
  );

describe('the Shopify cart', () => {
  it('posts to the host page own endpoint, relative', async () => {
    /* `/cart/add.js` belongs to the shop, not to us. An absolute URL anywhere
     * else adds a wine to nobody's basket. */
    const fetch_ = responding({ status: 200 });

    await addToShopifyCart({ variantId: '45123456789', sessionId: SESSION, fetch: fetch_ });

    /* Written out rather than compared to `ADD_PATH`: an assertion against the
     * constant passes however the constant changes. */
    expect(fetch_.mock.calls[0]?.[0]).toBe('/cart/add.js');
    expect(ADD_PATH.startsWith('/')).toBe(true);
  });

  it('sends the line in the shape Shopify reads', async () => {
    const fetch_ = responding({ status: 200 });

    await addToShopifyCart({
      variantId: '45123456789',
      quantity: 2,
      sessionId: SESSION,
      fetch: fetch_,
    });

    expect(bodyOf(fetch_)).toEqual({
      items: [{ id: '45123456789', quantity: 2, properties: { [SESSION_PROPERTY]: SESSION } }],
    });
  });

  it('carries the session property, which is what makes attribution possible', async () => {
    /*
     * P6-07 reads this off the order. Attribution cannot be reconstructed after
     * the fact, so an order placed today without it is one we can never claim.
     */
    const fetch_ = responding({ status: 200 });

    await addToShopifyCart({ variantId: '1', sessionId: SESSION, fetch: fetch_ });

    const body = bodyOf(fetch_) as { items: { properties: Record<string, string> }[] };

    expect(body.items[0]?.properties[SESSION_PROPERTY]).toBe(SESSION);
  });

  it('sends the shop own cookie, because the cart is the cookie', async () => {
    /* The opposite of our own surface (P2-08), and for the opposite reason: a
     * request without it creates a cart the shopper will never see. */
    const fetch_ = responding({ status: 200 });

    await addToShopifyCart({ variantId: '1', sessionId: SESSION, fetch: fetch_ });

    expect(fetch_.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  });

  it('defaults to one bottle', async () => {
    const fetch_ = responding({ status: 200 });

    await addToShopifyCart({ variantId: '1', sessionId: SESSION, fetch: fetch_ });

    const body = bodyOf(fetch_) as { items: { quantity: number }[] };

    expect(body.items[0]?.quantity).toBe(1);
  });

  it('surfaces the shop own wording for a sold-out variant', async () => {
    /*
     * Shopify answers 422 with a sentence written for a shopper in the shop's
     * own language, which is far better than anything we would invent.
     */
    const fetch_ = responding({ status: 422 }, { description: 'Barolo Bussia è esaurito.' });

    await expect(
      addToShopifyCart({ variantId: '1', sessionId: SESSION, fetch: fetch_ }),
    ).rejects.toThrow('Barolo Bussia è esaurito.');
  });

  it('reads `message` when that is what arrived instead', async () => {
    const fetch_ = responding({ status: 422 }, { message: 'Non disponibile.' });

    await expect(
      addToShopifyCart({ variantId: '1', sessionId: SESSION, fetch: fetch_ }),
    ).rejects.toThrow('Non disponibile.');
  });

  it('still refuses when the body is not JSON at all', async () => {
    const fetch_ = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('<html>502</html>', { status: 502 })),
    );

    await expect(
      addToShopifyCart({ variantId: '1', sessionId: SESSION, fetch: fetch_ }),
    ).rejects.toBeInstanceOf(ShopifyRefused);
  });
});

describe('the Shopify count', () => {
  it('reads the cart back rather than counting up', async () => {
    /* A shopper may have added wines in another tab. A number we incremented
     * ourselves would drift and be wrong in a way nobody could explain. */
    const fetch_ = responding({ status: 200 }, { item_count: 3 });

    expect(await shopifyCartCount(fetch_)).toBe(3);
    expect(fetch_.mock.calls[0]?.[0]).toBe('/cart.js');
    expect(CART_PATH.startsWith('/')).toBe(true);
  });

  it('answers nothing when the shop refuses', async () => {
    expect(await shopifyCartCount(responding({ status: 500 }))).toBeUndefined();
  });

  it('answers nothing when the network fails, rather than breaking the widget', async () => {
    const fetch_ = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new TypeError('offline')));

    expect(await shopifyCartCount(fetch_)).toBeUndefined();
  });

  it('answers nothing for a count that is not a number', async () => {
    expect(
      await shopifyCartCount(responding({ status: 200 }, { item_count: 'three' })),
    ).toBeUndefined();
  });
});

describe('the seller own object', () => {
  it('is called with the wine', async () => {
    const addToCart = vi.fn(() => Promise.resolve());

    await addViaObject({ addToCart, getCount: () => 0 }, ITEM);

    expect(addToCart).toHaveBeenCalledWith(ITEM);
  });

  it('accepts an implementation that is not async', async () => {
    const cart: SommelierCart = { addToCart: () => undefined, getCount: () => 0 };

    await expect(addViaObject(cart, ITEM)).resolves.toBeUndefined();
  });

  it('turns a synchronous throw into a rejection', async () => {
    const cart: SommelierCart = {
      addToCart: () => {
        throw new Error('il carrello è rotto');
      },
      getCount: () => 0,
    };

    await expect(addViaObject(cart, ITEM)).rejects.toThrow('il carrello è rotto');
  });

  it('times out an implementation that never settles', async () => {
    /* A seller's endpoint is down and their promise never resolves. Without a
     * bound, the shopper watches a spinner until they close the tab. */
    vi.useFakeTimers();

    const cart: SommelierCart = {
      addToCart: () => new Promise<void>(() => undefined),
      getCount: () => 0,
    };
    const adding = addViaObject(cart, ITEM, 100);
    const assertion = expect(adding).rejects.toThrow('non ha risposto');

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('leaves no timer running once the add has finished', async () => {
    /* `Promise.race` decides, and the loser is a `setTimeout` that keeps the
     * page awake for five seconds on every single add. */
    vi.useFakeTimers();

    await addViaObject({ addToCart: () => undefined, getCount: () => 0 }, ITEM);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('reads their count', async () => {
    expect(await countViaObject({ addToCart: () => undefined, getCount: () => 4 })).toBe(4);
  });

  it('answers nothing when their count throws', async () => {
    const cart: SommelierCart = {
      addToCart: () => undefined,
      getCount: () => {
        throw new Error('boom');
      },
    };

    expect(await countViaObject(cart)).toBeUndefined();
  });

  it('answers nothing for a count that is not a finite number', async () => {
    expect(
      await countViaObject({ addToCart: () => undefined, getCount: () => Number.NaN }),
    ).toBeUndefined();
  });
});

describe('the event contract', () => {
  const listening = (respond: (detail: unknown) => unknown): EventTarget => {
    const target = new EventTarget();

    target.addEventListener(ADD_EVENT, (event) => {
      const detail = respond((event as CustomEvent<unknown>).detail);

      if (detail !== undefined) {
        target.dispatchEvent(new CustomEvent(ACK_EVENT, { detail }));
      }
    });

    return target;
  };

  it('dispatches the wine and resolves on the ack', async () => {
    const target = listening((detail) => ({ ...(detail as object), ok: true }));

    await expect(addViaEvent(ITEM, { target })).resolves.toBeUndefined();
  });

  it('passes the wine in the event detail', async () => {
    let seen: unknown;
    const target = listening((detail) => {
      seen = detail;

      return { ok: true };
    });

    await addViaEvent(ITEM, { target });

    expect(seen).toEqual(ITEM);
  });

  it('rejects when the seller says no', async () => {
    /* Their cart saying no, told apart from their page saying nothing. */
    const target = listening(() => ({ productId: 'p1', ok: false }));

    await expect(addViaEvent(ITEM, { target })).rejects.toThrow('non ha aggiunto');
  });

  it('ignores an ack for a different wine', async () => {
    vi.useFakeTimers();

    const target = listening(() => ({ productId: 'p2', ok: true }));
    const adding = addViaEvent(ITEM, { target, timeoutMs: 50 });
    const assertion = expect(adding).rejects.toThrow('non ha risposto');

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('times out when nothing is listening', async () => {
    /* Which is the same outcome as listening and never acking — correct,
     * because from here those two are the same thing. */
    vi.useFakeTimers();

    const adding = addViaEvent(ITEM, { target: new EventTarget(), timeoutMs: 50 });
    const assertion = expect(adding).rejects.toThrow('non ha risposto');

    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('stops listening once the add is done', async () => {
    const target = listening(() => ({ ok: true }));
    const removed = vi.spyOn(target, 'removeEventListener');

    await addViaEvent(ITEM, { target });

    expect(removed).toHaveBeenCalledWith(ACK_EVENT, expect.any(Function));
  });

  it('stops listening even when nothing ever acks', async () => {
    /*
     * The leak that matters: a seller who never acks would otherwise collect
     * one listener per add on their `document`, each holding a promise nobody
     * will settle, for as long as the visitor stays on the page.
     */
    vi.useFakeTimers();

    const target = new EventTarget();
    const removed = vi.spyOn(target, 'removeEventListener');
    const adding = addViaEvent(ITEM, { target, timeoutMs: 50 });
    const assertion = expect(adding).rejects.toThrow('non ha risposto');

    await vi.advanceTimersByTimeAsync(50);
    await assertion;

    expect(removed).toHaveBeenCalledWith(ACK_EVENT, expect.any(Function));
  });

  it('accepts an ack with no detail at all', async () => {
    const target = new EventTarget();

    target.addEventListener(ADD_EVENT, () => {
      target.dispatchEvent(new CustomEvent(ACK_EVENT));
    });

    await expect(addViaEvent(ITEM, { target })).resolves.toBeUndefined();
  });
});

describe('one port over all of them', () => {
  const item = { productId: 'p1', quantity: 1, variantId: '45123456789' } as const;

  it('reports that there is nowhere to add when there is not', () => {
    const port = createCartPort({ adapter: { k: 'none' }, sessionId: SESSION });

    expect(port.canAdd).toBe(false);
  });

  it('answers no count when there is no cart', async () => {
    const port = createCartPort({ adapter: { k: 'none' }, sessionId: SESSION });

    expect(await port.count()).toBeUndefined();
  });

  it('refuses a Shopify add for a wine with no variant id', async () => {
    /* A seller's blank column, not a shopper's problem — and the card disables
     * the button before this can happen. */
    const port = createCartPort({
      adapter: { k: 'shopify' },
      sessionId: SESSION,
      fetch: responding({ status: 200 }),
    });

    await expect(port.add({ ...item, variantId: null })).rejects.toBeInstanceOf(VariantMissing);
  });

  it('says a Shopify cart needs a variant id, so a card can disable its button', () => {
    expect(createCartPort({ adapter: { k: 'shopify' }, sessionId: SESSION }).needsVariantId).toBe(
      true,
    );
  });

  it('says the seller own cart does not, because it takes our product id', () => {
    const cart: SommelierCart = { addToCart: () => undefined, getCount: () => 0 };

    expect(
      createCartPort({ adapter: { k: 'generic', cart }, sessionId: SESSION }).needsVariantId,
    ).toBe(false);
  });

  it('adds through the seller own object', async () => {
    const addToCart = vi.fn(() => Promise.resolve());
    const port = createCartPort({
      adapter: { k: 'generic', cart: { addToCart, getCount: () => 2 } },
      sessionId: SESSION,
    });

    await port.add(item);

    expect(addToCart).toHaveBeenCalledOnce();
    expect(await port.count()).toBe(2);
  });

  it('offers no count for the event contract', async () => {
    /* Reading one would need a second round trip of events and a second
     * timeout, and the badge is a nicety. */
    const port = createCartPort({
      adapter: { k: 'event' },
      sessionId: SESSION,
      target: new EventTarget(),
    });

    expect(await port.count()).toBeUndefined();
  });
});
