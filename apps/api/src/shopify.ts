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
  scopesCovered,
  setRequestTenant,
  SHOP_EXPECTED,
  SHOPIFY_STATE_TTL_MS,
  stateHash,
  verificationToken,
  verifyCallbackHmac,
  type MembershipReader,
} from '@catalogorosso/core';
import {
  insertDomain,
  markDomainVerified,
  markShopifyUninstalled,
  readDomainByOrigin,
  readShopifyInstallation,
  readTenantPlan,
  recordShopifyInstall,
  resolveTenantByShop,
  spendShopifyState,
  startShopifyInstall,
  withTenant,
  type SpentState,
} from '@catalogorosso/db';
import { can, isOwnerOnly, type PlanTier } from '@catalogorosso/security';
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
 */

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
  /** `app/uninstalled`: the token goes, and the shop is marked. */
  readonly uninstalled: (shop: string) => Promise<'uninstalled' | 'unknown'>;
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

        await audit(tx, {
          action: 'shopify.installed',
          target: shop,
          metadata: { scopes: token.scope, domain },
        });

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

    uninstalled: async (shop) => {
      if (!isShopDomain(shop)) return 'unknown';

      const tenantId = await resolveShop(shop);

      if (tenantId === undefined) return 'unknown';

      setRequestTenant(tenantId);

      await withTenant(tenantId, async (tx) => {
        await markShopifyUninstalled(tx, shop);
        await audit(tx, { action: 'shopify.uninstalled', target: shop });
        await tokens.remove(tenantId, shop);
      });

      return 'uninstalled';
    },
  };
};
