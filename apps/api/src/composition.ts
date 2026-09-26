import {
  betterAuthRateLimitStorage,
  chooseTransport,
  createAuth,
  assertQueryProviderMatchesIndex,
  createSendEmail,
  getRequestActor,
  logTransport,
  resendTransport,
  type IndexedEmbedding,
  type MembershipReader,
  type ResetPasswordEmail,
  type SuppressionCheck,
} from '@catalogorosso/core';
import { bedrockNovaProvider, titanEmbeddingProvider } from '@catalogorosso/llm';
import { memoryRateLimiter, type MonthlyCheck, type RateLimiter } from '@catalogorosso/security';
import { loadWidgetTokenKeys, type WidgetTokenKeys } from '@catalogorosso/security/tokens';
import {
  insertAuditRow,
  insertSecurityEvent,
  isSuppressed,
  isTokenRevoked,
  resolveTenantBySecretKey,
  sessionCutoffAt,
  readMembershipsForUser,
  resolveTenantByKeyAndOrigin,
  withTenant,
  withUser,
} from '@catalogorosso/db';

import { createDomainsPort, type DomainsPort } from './domains.js';
import { createKeysPort, type KeysPort } from './keys.js';
import { createMembersPort, type MembersPort } from './members.js';
import { recordTwoFactorChange } from './mfa-audit.js';
import { logger } from './middleware/logger.js';
import { createProductsPort, type ProductsPort } from './products.js';
import { createChatPort, type ChatPort } from './chat.js';
import { createQuotaPort, type QuotaPort } from './quota.js';
import { createRagPort, type RagPort } from './rag.js';
import { refusalRecorders } from './security-events.js';
import type { WidgetDependencies } from './surfaces/widget.js';
import { createWebhooksPort, type WebhooksPort } from './webhooks.js';
import type { AuthPort } from './middleware/auth.js';
import { AUTH_PUBLIC_PATH } from './routes.js';

/**
 * What the entry point assembles, extracted so it can be asserted (E9).
 *
 * **The extraction is most of the fix.** `index.ts` used to do this work at
 * module scope and threw on import without `AUTH_SECRET`, so no test could look
 * at it — and none did. P0-64 and P0-51 were each verified against their own
 * seam, with a fake transport and a fake port, and both suites were green while
 * the real entry point wired neither: password reset sent nothing, and the
 * invite endpoints answered 500 through the fail-loud default that was written
 * to catch exactly this and had quietly become the implementation.
 *
 * A green suite that says nothing about the one place the real dependencies
 * meet is the shape of failure worth naming here, because every individual
 * piece looks correct in isolation and is.
 */

/**
 * Better Auth's reset-token lifetime, in minutes.
 *
 * Stated here because the *email* quotes it to the reader, and a number in the
 * message that disagrees with the one enforced is worse than no number: it
 * teaches people the link lasts longer than it does.
 */
const RESET_EXPIRY_MINUTES = 60;

export interface RuntimeConfig {
  /** Signs cookies and tokens. From SSM in a deployment (P0-15). */
  readonly authSecret: string;
  /** The origin Better Auth builds callback and reset URLs against. */
  readonly authBaseUrl: string;
  /**
   * The deployment stage.
   *
   * Load-bearing for email: `chooseTransport` sends through the provider only
   * when this is exactly `production` and routes everything else to the log. A
   * typo here does not open a hole, it closes one — mail that should have been
   * sent is logged instead, which is the safe direction for a value this
   * important.
   */
  readonly stage: string;
  /** `Sommelier <noreply@…>`; the domain must be the authenticated one (E6). */
  readonly emailFrom: string;
  /**
   * Absent until the sending domain is authenticated (E6), and that must not
   * stop the container starting: an API that refuses to boot for want of an
   * email key is a worse outage than one that logs its mail.
   */
  readonly resendApiKey?: string | undefined;
  /** Addresses that may receive real mail from a non-production stage. */
  readonly emailAllowlist?: readonly string[] | undefined;
  /** Where an invitee lands. The token is appended as the last path segment. */
  readonly acceptUrlBase?: string | undefined;
  /** Injected so a test can read what the log transport wrote. */
  readonly log?: ((line: string) => void) | undefined;
  /** Raised when a message is finally abandoned, for the P0-64 alarm. */
  readonly onEmailFailure?: ((failure: { readonly to: string }) => void) | undefined;
  /**
   * How the suppression list is read on the reset path.
   *
   * A port for the reason every other port here exists (P0-09): the default
   * opens a real transaction, so without this the one test that asserts the
   * reset wiring would need a container to check a string. Production never
   * passes it.
   */
  readonly suppression?: ((userId: string) => SuppressionCheck) | undefined;
  /**
   * The shared secret CloudFront attaches to origin requests (A2).
   *
   * Absent is permitted only where there is no CloudFront in front — a local
   * run, or the suite. `buildDependencies` does not police that; `index.ts`
   * does, because it is the only place that knows whether this is a deployment.
   */
  readonly originSecret?: string | undefined;
  /**
   * Where auth rate-limit counters live (A1).
   *
   * Absent means Better Auth's own in-memory store, which in Lambda counts
   * **per container**: N warm containers give an attacker N times each
   * configured limit, and a recycle resets the counter to zero. Correct for a
   * local run and the suite; never for a deployment, which `index.ts` enforces.
   *
   * A port rather than a construction here, for the reason every port in this
   * file exists: the default opens a database transaction, so a test asserting
   * the wiring would otherwise need a container to check a string.
   */
  readonly rateLimiter?: RateLimiter | undefined;

  /**
   * The Resend endpoint signing secret, `whsec_…` (P0-64b).
   *
   * Absent is **restrictive**: the webhook endpoint refuses every delivery,
   * because with no secret there is nothing to verify a signature against. That
   * is the opposite of `originSecret` above, and it is why this one needs no
   * deployment guard — what its absence costs is bounces going unrecorded (E7),
   * not a hole. Passed straight through rather than being read here, because
   * only the surface has a use for it.
   */
  readonly resendWebhookSecret?: string | undefined;

  /**
   * Reads how much of a limit window has been spent without spending it (P2-10):
   * `createRateLimiter().peek` in a deployment. Absent means an untouched month,
   * which is what a local run with an in-process limiter honestly has.
   */
  readonly readUsage?: ((check: MonthlyCheck) => Promise<number>) | undefined;

  /**
   * The widget token keyset, serialised (P2-11). Absent — every stage until an
   * operator sets `WidgetTokenKeys` — leaves the session route answering with a
   * wiring error, which is restrictive: nothing is minted without a key.
   */
  readonly widgetTokenKeys?: string | undefined;
}

/**
 * Loads the keyset once per container, on first use, and keeps the attempt.
 *
 * A keyset that will not load does not repair itself without a deploy, so a
 * failed load is kept rather than retried: every mint fails with the same
 * reason, which reaches the log and never a response (P0-55).
 */
const keysLoader = (serialized: string): (() => Promise<WidgetTokenKeys>) => {
  let loading: Promise<WidgetTokenKeys> | undefined;

  return () => {
    loading ??= loadWidgetTokenKeys(serialized);
    return loading;
  };
};

export interface Dependencies {
  readonly auth: AuthPort;
  /** Passed through to `createApp`; absent means the guard is not installed. */
  readonly originSecret?: string | undefined;
  readonly readMemberships: MembershipReader;
  readonly members: MembersPort;
  /** Domains (P4-01). */
  readonly domains: DomainsPort;
  /** Keys (P4-09). */
  readonly keys: KeysPort;
  /** The catalogue (P1-02). */
  readonly products: ProductsPort;
  /** The retrieval sandbox (P2-37). */
  readonly rag: RagPort;
  /** The monthly plan cap (P2-36). Exposed so P2-29's route can gate on it. */
  readonly quota: QuotaPort;
  /** Answers one question (P2-29). */
  readonly chat: ChatPort;
  /** Records provider delivery events (P0-64b). */
  readonly webhooks: WebhooksPort;
  /** Passed through to `createApp`; absent means the endpoint refuses. */
  readonly resendWebhookSecret?: string | undefined;
  /** The widget surface's resolution, limits and usage read (P2-04 to P2-10). */
  readonly widget: WidgetDependencies;
  /** Exposed so the wiring is assertable, not because anything else calls it. */
  readonly sendResetPassword: (email: ResetPasswordEmail) => Promise<void>;
}

/**
 * Reads the suppression list on a path that has no tenant.
 *
 * `withUser` rather than an un-scoped connection, and the choice is the point.
 * `email_suppressions` carries no `tenant_id` and no policy, so *any* connection
 * could read it — but "any connection" is precisely what this repository does
 * not hand out (P0-19). `withUser` is the narrowest sanctioned context available
 * on a password-reset path, where the user is known and the tenant is not and
 * never will be. It costs one short transaction and adds no new escape hatch,
 * which is worth more than the round trip it saves.
 */
const suppressionForUser = (userId: string): SuppressionCheck => ({
  isSuppressed: (address) => withUser(userId, (tx) => isSuppressed(tx, address)),
});

/**
 * What the catalogue's vectors were produced by (P2-17).
 *
 * **Written out rather than imported from the adapter**, which looks like the
 * duplication P0-42 forbids and is the opposite of it. These two values
 * describe rows already in `product_embeddings`; the adapter describes what the
 * next call will produce. Taking both from the same constant would compare a
 * value with itself, and the check exists precisely for the deployment that
 * changes one of them — P1-47's bake-off is a configuration change away from
 * being that deployment.
 *
 * Changing the indexed model means re-embedding every wine under a new
 * `version` (P1-49) and moving this line with it.
 */
const INDEXED_EMBEDDING: IndexedEmbedding = {
  model: 'amazon.titan-embed-text-v2:0',
  dim: 1024,
};

/**
 * The two tiers a question can be answered by (§5.3, P2-28).
 *
 * **Written out rather than read from the environment.** Which model answers is
 * a decision with a price attached, and a deployment that could change it from
 * a variable is a deployment that could change the bill without a commit.
 * P1-47's bake-off moves these lines; it does not set a variable.
 */
const CHAT_MODELS = {
  base: 'amazon.nova-lite-v1:0',
  strong: 'amazon.nova-2-lite-v1:0',
} as const;

export const buildDependencies = (config: RuntimeConfig): Dependencies => {
  const log = logTransport(config.log);
  const quota = createQuotaPort();

  /*
   * Answering a question (P2-29). The providers are factories rather than
   * instances because tokens are reported per construction (P1-42's `onUsage`)
   * and the bill is per turn — the SDK client is the expensive part, and
   * `bedrockNovaProvider` builds one per call unless given one, so this is the
   * place that keeps that cost in check.
   */
  const chat = createChatPort({
    embeddings: assertQueryProviderMatchesIndex(titanEmbeddingProvider(), INDEXED_EMBEDDING),
    providers: {
      base: (onUsage) => bedrockNovaProvider({ modelId: CHAT_MODELS.base, onUsage }),
      strong: (onUsage) => bedrockNovaProvider({ modelId: CHAT_MODELS.strong, onUsage }),
    },
    models: CHAT_MODELS,
    quota,
  });

  /*
   * The provider is built only when there is a key. Without one the log
   * transport stands in on every stage, which is correct rather than degraded:
   * the sending domain is not authenticated yet (E6), so a real send would be
   * rejected anyway — and rejected *after* spending a request, where the log is
   * immediate and readable.
   */
  const provider =
    config.resendApiKey === undefined
      ? log
      : resendTransport({ apiKey: config.resendApiKey, fetch: globalThis.fetch });

  const transport = chooseTransport({
    stage: config.stage,
    provider,
    log,
    allowlist: config.emailAllowlist,
  });

  const sendEmailWith = (suppression: SuppressionCheck) =>
    createSendEmail({
      transport,
      from: config.emailFrom,
      suppression,
      onFailure: config.onEmailFailure,
    });

  const suppressionFor = config.suppression ?? suppressionForUser;

  /**
   * The real reset sender, replacing the placeholder that logged and resolved.
   *
   * It still **resolves rather than throwing on a suppressed address**, and
   * that inherits the placeholder's reasoning rather than repeating it by
   * accident: Better Auth calls this only when the address belongs to a real
   * user, so a sender that threw would make reset 500 for real addresses and
   * 200 for invented ones — an account-enumeration oracle manufactured by the
   * error path, and exactly what P0-46's enumeration group exists to prevent.
   * `sendEmail` returns a `suppressed` outcome rather than throwing, for
   * callers shaped like this one.
   */
  const sendResetPassword = async (email: ResetPasswordEmail): Promise<void> => {
    await sendEmailWith(suppressionFor(email.userId))({
      to: email.to,
      template: 'password-reset',
      props: { resetUrl: email.url, expiresInMinutes: RESET_EXPIRY_MINUTES },
    });
  };

  return {
    auth: createAuth({
      secret: config.authSecret,
      baseUrl: config.authBaseUrl,

      /*
       * Present only when a limiter was supplied. Passing `undefined` is
       * equivalent to omitting it, but writing it conditionally keeps the
       * intent visible: without one this is deliberately the library's
       * per-container default, and that is `index.ts`'s decision to allow.
       */
      ...(config.rateLimiter === undefined
        ? {}
        : { rateLimitStorage: betterAuthRateLimitStorage(config.rateLimiter) }),

      /*
       * The *mounted* path, not `/auth`. Better Auth is handed the raw
       * `Request`, whose URL carries the whole path, and it builds reset and
       * callback URLs from `baseUrl + basePath` — so the sub-app-relative
       * prefix would both fail to match and email people links going nowhere.
       */
      basePath: AUTH_PUBLIC_PATH,
      sendResetPassword,

      /*
       * One audit row per winery the user belongs to (P4-11), each written in
       * that winery's own scope. The address and agent come from the request
       * context as every audit row's do; the actor is the user whose factor
       * changed, because on an `/auth` route nobody else is known.
       */
      onTwoFactorChange: recordTwoFactorChange({
        memberships: (userId) => readMembershipsForUser(userId),
        record: (tenantId, row) =>
          withTenant(tenantId, async (tx) => {
            const { ip, userAgent } = getRequestActor();

            await insertAuditRow(tx, {
              tenantId,
              actorUserId: row.actorUserId,
              action: row.action,
              target: row.target,
              metadata: undefined,
              ip,
              userAgent,
            });
          }),
        onFailure: (error, change) => {
          logger.error({ err: error, event: change.event }, 'two-factor change not audited');
        },
      }),
    }),

    readMemberships: readMembershipsForUser,

    ...(config.originSecret === undefined ? {} : { originSecret: config.originSecret }),

    /*
     * The invite path checks the suppression list inside the transaction it
     * already holds (see `members.ts`), which is both cheaper and better —
     * an invitation for an undeliverable address is never created at all. So
     * the seam's own check has nothing left to do on that path, and passing a
     * no-op says so rather than opening a second connection to ask a question
     * already answered.
     */
    members: createMembersPort({
      sendEmail: sendEmailWith({ isSuppressed: () => Promise.resolve(false) }),
      acceptUrlBase: config.acceptUrlBase ?? `${config.authBaseUrl}/invito`,
    }),

    /*
     * Built unconditionally: there is no configuration that makes writing a
     * product wrong, and every gate in front of it — the session, the tenant,
     * the capability — is applied before this is reached.
     */
    products: createProductsPort(),

    /*
     * Domains (P4-01). The environment is decided the same way the widget
     * surface decides it and from the same value, because they are two halves
     * of one rule: an origin a seller may *add* and an origin a widget may be
     * *served to* have to be the same set, or a local run adds domains the
     * widget will then refuse.
     */
    /* Keys (P4-09). No configuration: generation and hashing are local, and
     * the only thing that could be wrong about them is tested where they live. */
    keys: createKeysPort(),

    domains: createDomainsPort({
      environment: config.stage === 'unknown' ? 'development' : 'production',
      /*
       * The same limiter every other counted path uses (P2-02). Absent in a
       * test; never absent here, because an uncounted verify endpoint is a way
       * to drive DNS queries from our address at somebody else's nameservers.
       */
      ...(config.rateLimiter === undefined ? {} : { limiter: config.rateLimiter }),
    }),

    /** The monthly plan cap (P2-36), read from `usage_events` rather than a bucket. */
    quota,

    /*
     * Answering a question (P2-29). The providers are factories rather than
     * instances because tokens are reported per construction (P1-42's
     * `onUsage`), and the bill is per turn — the SDK client is the expensive
     * part and it is built once, here.
     */
    chat,

    /*
     * The retrieval sandbox (P2-37), and the first place P2-17's startup check
     * is a real one. `assertQueryProviderMatchesIndex` throws here rather than
     * on a request, so a provider that cannot read this catalogue's vectors
     * fails the deployment and the previous version keeps answering.
     */
    rag: createRagPort({
      provider: assertQueryProviderMatchesIndex(titanEmbeddingProvider(), INDEXED_EMBEDDING),
    }),

    /*
     * Built unconditionally, unlike the secret beside it. The port is what
     * records a bounce once one is verified, and there is no configuration that
     * makes recording one wrong — the gate is the signature, which the surface
     * applies before this is ever reached.
     */
    webhooks: createWebhooksPort(),

    /*
     * The widget surface (P2-10). Resolution is the real accessor, always. The
     * limiter is the Postgres one `index.ts` supplies in a deployment — which it
     * refuses to start without — and an in-process one only on a local run, where
     * there is one visitor and no fleet of containers to multiply the limits
     * across. The address salt derives from the auth secret, which `bucketIp`
     * turns into a daily key, so there is no second secret to lose.
     */
    widget: {
      resolve: resolveTenantByKeyAndOrigin,
      limiter: config.rateLimiter ?? memoryRateLimiter(),
      /*
       * The month, read from the ledger (P2-36). Before this it was a hardcoded
       * nought, so §2.3's banner told every seller `ok` however much they had
       * spent — the cost control that makes the plan cap meaningful reporting
       * that nothing had been used.
       */
      readUsage: config.readUsage ?? quota.readUsage,
      ipSecret: config.authSecret,
      environment: config.stage === 'unknown' ? 'development' : 'production',
      ...(config.widgetTokenKeys === undefined
        ? {}
        : { tokenKeys: keysLoader(config.widgetTokenKeys) }),
      isTokenRevoked,
      /*
       * Supplied unconditionally, like `isTokenRevoked`. A verifier that cannot
       * ask whether an origin's sessions were ended accepts them (P4-06), and
       * the absent-means-refuse default in the surface is a backstop for a
       * wiring bug rather than a configuration anybody should choose.
       */
      sessionCutoffAt,
      /*
       * The server-to-server mint (P4-10). Supplied unconditionally: without it
       * the route refuses every key, which is safe and useless.
       */
      resolveSecretKey: (hash: string) => resolveTenantBySecretKey(hash),
      /*
       * Where a refused widget request is recorded (P2-16). The middleware
       * reports through a hook that swallows a throw and a rejection alike, so
       * a database refusing writes cannot become a way to refuse service.
       */
      onRejected: refusalRecorders(insertSecurityEvent).onRejected,

      /** A refused *token* (P2-16), which is a different fact from a refused origin. */
      onTokenRejected: refusalRecorders(insertSecurityEvent).onTokenRejected,

      /** The metric's one dimension (P2-28). */
      stage: config.stage,

      chat,
    },

    ...(config.resendWebhookSecret === undefined
      ? {}
      : { resendWebhookSecret: config.resendWebhookSecret }),

    sendResetPassword,
  };
};
