import { describe, expect, it } from 'vitest';

import {
  ProductsPortNotConfiguredError,
  unconfiguredProducts,
  type ProductsPort,
} from '../src/products.js';
import {
  unconfiguredWebhooks,
  WebhooksPortNotConfiguredError,
  type WebhooksPort,
} from '../src/webhooks.js';

/**
 * The default ports refuse rather than pretend (P1-02, P0-64b).
 *
 * **Each of these exists to make one wiring bug loud, and until now none of
 * them had ever been observed doing it.** `members.ts` has the same pattern and
 * a test; products and webhooks acquired the pattern and not the test, which is
 * the shape a copied idiom takes when nobody checks the copy.
 *
 * The failure they guard against is specific. A port left unwired does not
 * throw a `TypeError` at some later line — it is a complete object whose
 * methods do nothing useful — so the route runs, the handler returns, and the
 * caller is told the work happened. For `record` that means telling Resend
 * every bounce was stored while the suppression list stayed empty: E7's
 * failure, indistinguishable from a domain with no bounces at all.
 *
 * A named rejection is what turns that into a message with the composition root
 * in it. Which only holds if every method carries one — hence the exhaustive
 * loop rather than a sample.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PRODUCT = '22222222-2222-4222-8222-222222222222';

describe('unconfiguredProducts', () => {
  /*
   * Every method, driven off the object rather than listed by hand: a fifth
   * method added to `ProductsPort` and wired to `undefined` would pass a test
   * that names the four it knows about.
   */
  const calls: Record<keyof ProductsPort, () => Promise<unknown>> = {
    create: () =>
      unconfiguredProducts.create({
        tenantId: TENANT,
        values: { sku: 'BAR-2019', name: 'Barolo' } as never,
      }),
    update: () =>
      unconfiguredProducts.update({ tenantId: TENANT, productId: PRODUCT, values: {} }),
    archive: () => unconfiguredProducts.archive({ tenantId: TENANT, productId: PRODUCT }),
    list: () => unconfiguredProducts.list({ tenantId: TENANT }),
  };

  it.each(Object.keys(calls) as (keyof ProductsPort)[])(
    'refuses %s with a named error',
    async (method) => {
      await expect(calls[method]()).rejects.toThrow(ProductsPortNotConfiguredError);
    },
  );

  it('covers every method the port declares', () => {
    // The guard on the guard. `unconfiguredProducts` is typed as `ProductsPort`,
    // so a new method must exist on it — this is what makes the loop above
    // exhaustive rather than merely long.
    expect(Object.keys(calls).sort()).toEqual(Object.keys(unconfiguredProducts).sort());
  });

  it('names the composition root, not the request', async () => {
    /*
     * The message is the whole value of the guard: an unwired port is a
     * deployment mistake, and the person reading the log needs to be sent to
     * `composition.ts` rather than to the route that happened to be called.
     */
    await expect(calls.create()).rejects.toThrow(/composition root/i);
  });
});

describe('unconfiguredWebhooks', () => {
  const calls: Record<keyof WebhooksPort, () => Promise<unknown>> = {
    record: () =>
      unconfiguredWebhooks.record({ eventId: 'evt_1', type: 'email.bounced' } as never),
  };

  it.each(Object.keys(calls) as (keyof WebhooksPort)[])(
    'refuses %s with a named error',
    async (method) => {
      await expect(calls[method]()).rejects.toThrow(WebhooksPortNotConfiguredError);
    },
  );

  it('covers every method the port declares', () => {
    expect(Object.keys(calls).sort()).toEqual(Object.keys(unconfiguredWebhooks).sort());
  });

  it('names the composition root, not the request', async () => {
    await expect(calls.record()).rejects.toThrow(/composition root/i);
  });
});
