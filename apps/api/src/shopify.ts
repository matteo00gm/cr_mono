import type { ShopifyStatusResponse } from '@catalogorosso/api-client';
import {
  audit,
  authorizeUrl,
  capFor,
  ConflictError,
  InvalidRequestError,
  isShopDomain,
  newStateNonce,
  normaliseShop,
  readCustomerRequest,
  readOrder,
  readProductStock,
  readRefund,
  readShopRedact,
  scopesCovered,
  setRequestTenant,
  SHOP_EXPECTED,
  SHOPIFY_STATE_TTL_MS,
  stateHash,
  STOCK_SYNC_PER_MINUTE,
  STOCK_SYNC_WINDOW_SEC,
  stockSyncLimitKey,
  TRIAL,
  verificationToken,
  verifyCallbackHmac,
  type MembershipReader,
} from '@catalogorosso/core';
import {
  countOrderEntries,
  deleteDomainProvedBy,
  endSessionsFor,
  eraseOrders,
  eraseShop,
  insertDomain,
  markDomainVerified,
  markShopifyUninstalled,
  readDomainByOrigin,
  readShopifyInstallation,
  readTenantPlan,
  recordAttributions,
  recordRefunds,
  recordShopifyInstall,
  resolveTenantByShop,
  spendShopifyState,
  startShopifyInstall,
  startTrial,
  syncStock,
  withTenant,
  type SpentState,
} from '@catalogorosso/db';
import { can, isOwnerOnly, type PlanTier, type RateLimiter } from '@catalogorosso/security';
import { guardedFetch } from '@catalogorosso/security/net';
import { z } from 'zod';

import type { ShopifyTokenStore } from './shopify-tokens.js';

/**
 * Connecting a winery's Shopify store (P6-06, ADR 0031).
 *
 * **The install is three steps, each in its own scope.** Starting it writes a
 * single-use state for the member, in their winery. Shopify's redirect comes
 * back with a code, the shop and that state, all signed with our app secret:
 * the HMAC is checked, then the state is spent in the member's own scope —
 * which is what says which winery this is, since the redirect carries no
 * tenant — then the membership is checked again, then the code is exchanged
 * for an offline token over `guardedFetch`. Only then, in the winery's scope:
 * the shop is recorded as theirs, its `myshopify.com` origin is proved — the
 * third method (§3.3), because Shopify asked its owner — and the token is put
 * where only this API can read it.
 *
 * **A failure says which, to the seller, and nothing more.** The redirect
 * goes back to the dashboard with a reason the screen can explain; none of
 * them names another winery, a secret, or anything the caller did not send.
 *
 * **The proof lasts as long as the install** (P6-06b, Open Decision 9). The
 * shop's origin was verified because Shopify asked its owner; when the owner
 * removes the app, that origin goes the way a removed domain goes — deleted,
 * its live sessions ended — unless the seller has proved it some other way.
 *
 * **An order is read for the lines we sold, and for nothing else** (P6-07).
 * `orders/create` carries a buyer's name and address; `readOrder` takes the
 * ids, quantities and amounts of the lines the widget planted a visit on, and
 * the rest of the body goes no further than the parser. Most orders have no
 * such line, and those never reach the database at all.
 */

/** What became of an `orders/create` delivery. */
export type OrderOutcome =
  /** At least one line was recorded as the sommelier's. */
  | 'attributed'
  /** Nothing to record: no line of ours, a visit that is not this winery's, or a redelivery. */
  | 'nothing'
  /** Not a shop, or a shop with no install to its name. */
  | 'unknown'
  /** Signed, and not an order we can read. */
  | 'unreadable';

/**
 * What became of a `products/update` delivery (P6-11).
 *
 * `throttled` is the one outcome that is not an acknowledgement: the shop has
 * sent more than this service will apply in a minute, and is asked to send
 * this one again. Shopify redelivers what it is refused, so nothing is lost —
 * and a report that arrives late changes nothing a newer one already said.
 */
export type StockOutcome =
  | { readonly outcome: 'synced' | 'nothing' | 'unknown' | 'unreadable' }
  | { readonly outcome: 'throttled'; readonly retryAfterSec: number };

/**
 * What became of one of Shopify's privacy requests (P6-09b).
 *
 * `held` is a data request this service has something to answer with: it is
 * recorded, and a person has to send the seller what is held. Everything else
 * is finished when it returns.
 */
export type PrivacyOutcome = 'erased' | 'held' | 'nothing' | 'unknown' | 'unreadable';

/** What became of a `refunds/create` delivery. */
export type RefundOutcome =
  /** At least one of our lines was reduced. */
  | 'reduced'
  /** Nothing to reduce: no line of ours in it, nothing left to take back, or a redelivery. */
  | 'nothing'
  | 'unknown'
  | 'unreadable';

/** Why an install did not complete, as the dashboard reads it. */
export type InstallFailure =
  | 'configurazione'
  | 'firma'
  | 'stato'
  | 'scaduto'
  | 'negozio'
  | 'permessi'
  | 'verifica'
  | 'scambio'
  | 'ambiti'
  | 'occupato';

/** What became of the shop's own domain when the install completed. */
export type ShopDomainOutcome = 'verificato' | 'limite' | 'occupato';

export const SHOPIFY_NOT_CONFIGURED =
  'Shopify is not set up on this service yet, so a store cannot be connected.';

export interface ShopifyConfig {
  /** The app's client id: public, it is in every authorize URL. */
  readonly clientId: string;
  readonly clientSecret: string;
}

/** What a code is exchanged for. */
export interface ExchangedToken {
  readonly accessToken: string;
  readonly scope: string;
}

export interface ShopifyPort {
  /** Starts an install: the URL of the shop's consent screen. */
  readonly install: (command: {
    readonly tenantId: string;
    readonly userId: string;
    readonly input: string;
  }) => Promise<{ readonly url: string }>;
  /** Finishes one: where to send the seller's browser, with how it went. */
  readonly callback: (command: {
    readonly userId: string;
    readonly mfaEnabled: boolean;
    readonly params: URLSearchParams;
  }) => Promise<string>;
  /** The winery's shop, if it connected one. */
  readonly status: (tenantId: string) => Promise<ShopifyStatusResponse>;
  /**
   * `app/uninstalled`: the shop is marked, its token goes, and so does the
   * origin the install proved. `stale` is news of an install that has since
   * been replaced, which changes nothing.
   */
  readonly uninstalled: (
    shop: string,
    triggeredAt?: Date,
  ) => Promise<'uninstalled' | 'stale' | 'unknown'>;
  /** `orders/create`: the lines the sommelier sold, recorded once each (P6-07). */
  readonly orderCreated: (shop: string, body: string) => Promise<OrderOutcome>;
  /** `refunds/create`: what came back is taken off what was sold, once (P6-08). */
  readonly refundCreated: (shop: string, body: string) => Promise<RefundOutcome>;
  /** `products/update`: each variant's stock, as the shop now reports it (P6-11). */
  readonly productUpdated: (shop: string, body: string) => Promise<StockOutcome>;
  /** `customers/redact`: what was recorded for a customer's orders is erased (P6-09b). */
  readonly customerRedact: (shop: string, body: string) => Promise<PrivacyOutcome>;
  /** `customers/data_request`: whether anything is held for a customer's orders, recorded if so. */
  readonly customerDataRequest: (shop: string, body: string) => Promise<PrivacyOutcome>;
  /** `shop/redact`: everything recorded for a shop's orders is erased. */
  readonly shopRedact: (shop: string, body: string) => Promise<PrivacyOutcome>;
}

export interface ShopifyDeps {
  /** Absent: nothing can be connected, and the dashboard is told so. */
  readonly config?: ShopifyConfig | undefined;
  /** Where Shopify sends the seller back: our callback, on the dashboard's origin. */
  readonly redirectUri: string;
  /** The dashboard screen the callback returns the seller to. */
  readonly returnTo: string;
  readonly tokens: ShopifyTokenStore;
  readonly readMemberships: MembershipReader;
  /** The code-for-token exchange. Defaults to a POST over `guardedFetch`. */
  readonly exchange?: ((shop: string, code: string) => Promise<ExchangedToken>) | undefined;
  readonly spendState?:
    ((userId: string, hash: string, now: Date) => Promise<SpentState | undefined>) | undefined;
  readonly resolveShop?: ((shop: string) => Promise<string | undefined>) | undefined;
  /**
   * The winery that holds a shop whether or not the app is still installed
   * (P6-09b): Shopify's privacy requests arrive after an uninstall.
   */
  readonly resolveHolder?: ((shop: string) => Promise<string | undefined>) | undefined;
  /**
   * Counts each shop's stock deliveries (P6-11). A shop whose products are
   * rewritten in bulk — an ERP sync, another app — sends one for every product
   * it touches. Absent, nothing is counted: a test's choice, never a
   * deployment's.
   */
  readonly limiter?: RateLimiter | undefined;
  readonly now?: (() => Date) | undefined;
}

const tokenAnswer = z.object({ access_token: z.string().min(1), scope: z.string() });

/**
 * The exchange over `guardedFetch` (P4-03a): our credentials, posted to the
 * shop the signed callback named and the state confirmed — a `myshopify.com`
 * name, so the secret goes to Shopify and nowhere else.
 */
export const exchangeOverGuardedFetch =
  (config: ShopifyConfig, fetch_: typeof guardedFetch = guardedFetch) =>
  async (shop: string, code: string): Promise<ExchangedToken> => {
    if (!isShopDomain(shop))
      throw new Error('refusing to send credentials to a shop that is not one');

    const response = await fetch_(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      json: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
      }),
      maxBytes: 4096,
    });

    if (response.status !== 200)
      throw new Error(`token exchange answered ${String(response.status)}`);

    const parsed = tokenAnswer.parse(JSON.parse(response.body));

    return { accessToken: parsed.access_token, scope: parsed.scope };
  };

export const unconfiguredShopify: ShopifyPort = {
  install: () => Promise.reject(new ConflictError(SHOPIFY_NOT_CONFIGURED)),
  callback: () => Promise.reject(new Error('No Shopify port was supplied to createApp.')),
  status: () => Promise.resolve({ configured: false, shop: null }),
  uninstalled: () => Promise.resolve('unknown'),
  orderCreated: () => Promise.resolve('unknown'),
  refundCreated: () => Promise.resolve('unknown'),
  productUpdated: () => Promise.resolve({ outcome: 'unknown' }),
  customerRedact: () => Promise.resolve('unknown'),
  customerDataRequest: () => Promise.resolve('unknown'),
  shopRedact: () => Promise.resolve('unknown'),
};

export const createShopifyPort = ({
  config,
  redirectUri,
  returnTo,
  tokens,
  readMemberships,
  exchange = config === undefined ? undefined : exchangeOverGuardedFetch(config),
  spendState = spendShopifyState,
  resolveShop = resolveTenantByShop,
  resolveHolder = (shop) => resolveTenantByShop(shop, undefined, { removed: true }),
  limiter,
  now = () => new Date(),
}: ShopifyDeps): ShopifyPort => {
  const back = (outcome: Record<string, string>): string => {
    const url = new URL(returnTo);

    for (const [name, value] of Object.entries(outcome)) url.searchParams.set(name, value);

    return url.toString();
  };
  const failed = (reason: InstallFailure): string => back({ shopify: 'errore', motivo: reason });

  /**
   * The shop's own origin, proved by the install: verified if the winery
   * already had it pending, added verified if not — within the plan's domain
   * allowance like any other — and left alone if another winery holds it.
   */
  const proveShopDomain = async (
    tx: Parameters<Parameters<typeof withTenant>[1]>[0],
    shop: string,
  ): Promise<ShopDomainOutcome> => {
    const origin = `https://${shop}`;
    const existing = await readDomainByOrigin(tx, origin);

    if (existing !== undefined) {
      if (existing.status === 'PENDING') await markDomainVerified(tx, existing.id, 'SHOPIFY');

      return 'verificato';
    }

    const plan: PlanTier = (await readTenantPlan(tx)) ?? 'none';
    const attempt = await insertDomain(
      tx,
      {
        origin,
        /* `myshopify.com` is a public suffix, so the shop is its own registrable domain. */
        registrableDomain: shop,
        verificationToken: verificationToken(),
        coveredBy: 'SHOPIFY',
      },
      capFor(plan),
    );

    if (attempt.outcome === 'created') return 'verificato';

    return attempt.outcome === 'taken' ? 'occupato' : 'limite';
  };

  return {
    install: async ({ tenantId, userId, input }) => {
      if (config === undefined) throw new ConflictError(SHOPIFY_NOT_CONFIGURED);

      const shop = normaliseShop(input);

      if (shop === undefined) throw new InvalidRequestError(SHOP_EXPECTED);

      const { nonce, hash } = newStateNonce();

      await withTenant(tenantId, (tx) =>
        startShopifyInstall(tx, {
          userId,
          shop,
          nonceHash: hash,
          expiresAt: new Date(now().getTime() + SHOPIFY_STATE_TTL_MS),
        }),
      );

      return {
        url: authorizeUrl({ shop, clientId: config.clientId, redirectUri, state: nonce }),
      };
    },

    callback: async ({ userId, mfaEnabled, params }) => {
      if (config === undefined || exchange === undefined) return failed('configurazione');

      /* Shopify sent this, or nothing below is believed. */
      if (!verifyCallbackHmac(params, config.clientSecret)) return failed('firma');

      const shop = params.get('shop') ?? '';
      const state = params.get('state');
      const code = params.get('code');

      if (!isShopDomain(shop)) return failed('negozio');
      if (state === null || state === '' || code === null || code === '') return failed('stato');

      /* Spent once, by the member who started it — and it says which winery. */
      const spent = await spendState(userId, stateHash(state), now());

      if (spent === undefined) return failed('stato');
      if (spent.expired) return failed('scaduto');
      if (spent.shop !== shop) return failed('negozio');

      /* Still allowed, now: a role can change in ten minutes. */
      const membership = (await readMemberships(userId)).find(
        (held) => held.tenantId === spent.tenantId,
      );

      if (membership === undefined || !can(membership.role, 'domains:manage')) {
        return failed('permessi');
      }

      if (isOwnerOnly('domains:manage') && !mfaEnabled) return failed('verifica');

      let token: ExchangedToken;

      try {
        token = await exchange(shop, code);
      } catch {
        return failed('scambio');
      }

      if (!scopesCovered(token.scope)) return failed('ambiti');

      /* The winery is known now, from the state; every log line and audit row carries it. */
      setRequestTenant(spent.tenantId);

      const outcome = await withTenant(spent.tenantId, async (tx) => {
        const recorded = await recordShopifyInstall(tx, { shop, scopes: token.scope });

        if (recorded === 'shop_taken') {
          await audit(tx, { action: 'shopify.install_shop_taken', target: shop });

          return { taken: true as const };
        }

        const domain = await proveShopDomain(tx, shop);

        /*
         * What became of the shop's domain, under a name the redactor lets
         * through (P0-56): audit metadata goes by the log allowlist, and a key
         * of our own choosing is recorded as `[redacted]`. The scopes are on
         * the installation row.
         */
        await audit(tx, {
          action: 'shopify.installed',
          target: shop,
          metadata: { status: domain },
        });

        /*
         * **The trial starts at the first verified domain, however it was
         * proved** (P6-06b, Open Decision 10) — the verify path's own rule
         * (P5-05), and its own statement: only from `PENDING_VERIFICATION`,
         * on this transaction.
         */
        if (domain === 'verificato' && (await startTrial(tx, TRIAL.days)) !== undefined) {
          await audit(tx, {
            action: 'billing.trial_started',
            target: `tenant:${spent.tenantId}`,
          });
        }

        /* Last, inside the transaction: a token is only kept for an install that was recorded. */
        await tokens.put(spent.tenantId, shop, token.accessToken);

        return { taken: false as const, domain };
      });

      if (outcome.taken) return failed('occupato');

      return back({ shopify: 'collegato', dominio: outcome.domain });
    },

    status: async (tenantId) => {
      if (config === undefined) return { configured: false, shop: null };

      const installation = await withTenant(tenantId, (tx) => readShopifyInstallation(tx));

      return {
        configured: true,
        shop:
          installation === undefined
            ? null
            : {
                shop: installation.shop,
                installedAt: installation.installedAt.toISOString(),
                uninstalledAt: installation.uninstalledAt?.toISOString() ?? null,
              },
      };
    },

    uninstalled: async (shop, triggeredAt) => {
      if (!isShopDomain(shop)) return 'unknown';

      const tenantId = await resolveShop(shop);

      if (tenantId === undefined) return 'unknown';

      setRequestTenant(tenantId);

      return withTenant(tenantId, async (tx) => {
        /* News of an install that was since replaced ends nothing of the new one. */
        if (!(await markShopifyUninstalled(tx, shop, triggeredAt))) return 'stale';

        /*
         * **One transaction: the mark, the delete, the cutoff and both audit
         * rows** — P4-06's shape, for its reason. Only the origin this install
         * proved: one the seller verified by DNS or by file stands on a proof
         * that an uninstall does not touch.
         */
        const origin = `https://${shop}`;
        const withdrawn = await deleteDomainProvedBy(tx, origin, 'SHOPIFY');

        if (withdrawn !== undefined) {
          await endSessionsFor(tx, origin);
          await audit(tx, {
            action: 'domain.removed',
            target: origin,
            metadata: { status: withdrawn.status, kind: 'shopify-uninstalled' },
          });
        }

        await audit(tx, { action: 'shopify.uninstalled', target: shop });
        await tokens.remove(tenantId, shop);

        return 'uninstalled';
      });
    },

    orderCreated: async (shop, body) => {
      if (!isShopDomain(shop)) return 'unknown';

      const order = readOrder(body);

      if (order === undefined) return 'unreadable';

      /* Most orders: nothing the widget added. Decided before any query is made. */
      if (order.lines.length === 0) return 'nothing';

      const tenantId = await resolveShop(shop);

      if (tenantId === undefined) return 'unknown';

      setRequestTenant(tenantId);

      const recorded = await withTenant(tenantId, (tx) =>
        recordAttributions(tx, { shop, ...order }),
      );

      return recorded > 0 ? 'attributed' : 'nothing';
    },

    refundCreated: async (shop, body) => {
      if (!isShopDomain(shop)) return 'unknown';

      const refund = readRefund(body);

      if (refund === undefined) return 'unreadable';

      /* Money handed back with no bottle returned names no line, and reduces none. */
      if (refund.lines.length === 0) return 'nothing';

      const tenantId = await resolveShop(shop);

      if (tenantId === undefined) return 'unknown';

      setRequestTenant(tenantId);

      /*
       * Whether a line was ours is the record's to say: the refund is joined to
       * the sales this winery has, and one for a wine the shopper found
       * themselves joins nothing.
       */
      const recorded = await withTenant(tenantId, (tx) => recordRefunds(tx, refund));

      return recorded > 0 ? 'reduced' : 'nothing';
    },

    productUpdated: async (shop, body) => {
      if (!isShopDomain(shop)) return { outcome: 'unknown' };

      const stock = readProductStock(body);

      if (stock === undefined) return { outcome: 'unreadable' };

      /* A product with no variant we can read has nothing to say about stock. */
      if (stock.variants.length === 0) return { outcome: 'nothing' };

      /*
       * **Counted before anything is asked of the database**, per shop, and
       * only for deliveries that would ask something. Over the allowance the
       * answer is "send it again", not "received": the latest report is the
       * one that matters, and an acknowledged drop would lose exactly that.
       */
      if (limiter !== undefined) {
        const allowance = await limiter.check([
          {
            key: stockSyncLimitKey(shop),
            limit: STOCK_SYNC_PER_MINUTE,
            windowSec: STOCK_SYNC_WINDOW_SEC,
          },
        ]);

        if (!allowance.allowed) {
          return { outcome: 'throttled', retryAfterSec: allowance.retryAfterSec ?? 1 };
        }
      }

      const tenantId = await resolveShop(shop);

      if (tenantId === undefined) return { outcome: 'unknown' };

      setRequestTenant(tenantId);

      /*
       * Stock columns only, and no outbox row (P1-33): a wine that sells out
       * costs one `UPDATE` and no embedding. A variant the catalogue does not
       * hold matches nothing — most of a shop's products are not wines we
       * were given.
       */
      const changed = await withTenant(tenantId, (tx) =>
        syncStock(tx, { sourceAt: stock.updatedAt, variants: stock.variants }),
      );

      return { outcome: changed > 0 ? 'synced' : 'nothing' };
    },

    customerRedact: async (shop, body) => {
      const request = readCustomerRequest(body);

      if (request === undefined) return 'unreadable';

      /* The body is what was signed; a header that names another shop is not believed. */
      if (request.shop !== shop) return 'unknown';
      if (request.orderIds.length === 0) return 'nothing';

      const tenantId = await resolveHolder(shop);

      if (tenantId === undefined) return 'unknown';

      setRequestTenant(tenantId);

      return withTenant(tenantId, async (tx) => {
        const erased = await eraseOrders(tx, request.orderIds);

        /* Most customers never met the sommelier: nothing held, nothing to record. */
        if (erased === 0) return 'nothing';

        await audit(tx, {
          action: 'shopify.customer_redacted',
          target: shop,
          metadata: { count: erased },
        });

        return 'erased';
      });
    },

    customerDataRequest: async (shop, body) => {
      const request = readCustomerRequest(body);

      if (request === undefined) return 'unreadable';
      if (request.shop !== shop) return 'unknown';
      if (request.orderIds.length === 0) return 'nothing';

      const tenantId = await resolveHolder(shop);

      if (tenantId === undefined) return 'unknown';

      setRequestTenant(tenantId);

      return withTenant(tenantId, async (tx) => {
        const held = await countOrderEntries(tx, request.orderIds);

        if (held === 0) return 'nothing';

        /*
         * **Recorded, because a person has to answer it.** Shopify asks that
         * the seller be given what is held, and nothing here sends it: the row
         * is what says a request is waiting, under the id Shopify gave it.
         */
        await audit(tx, {
          action: 'shopify.data_requested',
          target: request.requestId === undefined ? shop : `data_request:${request.requestId}`,
          metadata: { count: held },
        });

        return 'held';
      });
    },

    shopRedact: async (shop, body) => {
      const named = readShopRedact(body);

      if (named === undefined) return 'unreadable';
      if (named !== shop) return 'unknown';

      const tenantId = await resolveHolder(shop);

      if (tenantId === undefined) return 'unknown';

      setRequestTenant(tenantId);

      return withTenant(tenantId, async (tx) => {
        const erased = await eraseShop(tx, shop);

        if (erased === 0) return 'nothing';

        await audit(tx, {
          action: 'shopify.shop_redacted',
          target: shop,
          metadata: { count: erased },
        });

        return 'erased';
      });
    },
  };
};
