import { boolean, index, integer, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';

/**
 * Better Auth's tables (P0-23a).
 *
 * Identity moves into our database, which is what makes the foreign key in
 * P0-23 possible: `memberships.user_id` has had nothing to point at until now.
 *
 * **These tables are not tenant-scoped, and cannot be.** Authentication happens
 * *before* a tenant is known — that is the whole point of tenant resolution
 * reading `memberships` afterwards — so there is no context to scope a login
 * query by. They therefore carry no `tenant_id` and no RLS policy, which also
 * means P0-41's reflection test never sees them: it discovers tables *having* a
 * `tenant_id`, so these are out of scope rather than allowlisted. The same
 * correction as `processed_webhooks`.
 *
 * The consequence is worth stating plainly rather than leaving implicit:
 * `app_rw` can read every row in `auth_users`. That is inherent to
 * authentication rather than a gap — the login path has to find a user by
 * email before it knows which tenant they belong to — and it is why P0-46's
 * security suite tests these paths directly instead of relying on RLS.
 */

/**
 * `auth_users`, not `user`.
 *
 * `user` is a reserved word in Postgres: bare `user` is shorthand for
 * `CURRENT_USER`. Better Auth's default name would work only while every
 * reference stayed quoted, and the first unquoted use in a hand-written query
 * returns the *database role* instead of failing — a silent wrong answer rather
 * than an error. The `auth_` prefix is configured at Better Auth setup (P0-45),
 * and it is a data migration to change later, which is why it is settled here.
 */
export const authUsers = pgTable(
  'auth_users',
  {
    /**
     * `text`, not `uuid`.
     *
     * Better Auth issues text ids and fighting its id generation buys nothing.
     * `memberships.user_id` is already `text` for exactly this reason (P0-23),
     * and forcing uuid here would mean either patching the library's generator
     * or casting at every boundary.
     */
    id: text('id').primaryKey(),

    name: text('name').notNull(),

    /**
     * Unique, and the login lookup. Not `citext` despite the case-insensitivity
     * argument that made `tenants.slug` citext: Better Auth normalises email
     * itself, and a citext column here would silently diverge from what the
     * library believes it stored the moment that normalisation changed.
     */
    email: text('email').notNull(),

    emailVerified: boolean('email_verified').notNull().default(false),

    image: text('image'),

    /**
     * Required by the `twoFactor` plugin, not by us (P0-45).
     *
     * Better Auth 1.7.2 merges a `twoFactorEnabled` field into the *user* model
     * when that plugin is registered, and its own enable/disable endpoints
     * write to it. Mounting the plugin without this column fails at the first
     * `updateUser`, which is a runtime failure in the middle of MFA setup
     * rather than a startup one.
     */
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [unique('auth_users_email_unique').on(table.email)],
);

/**
 * `auth_sessions` — server-side sessions.
 *
 * Kept in Postgres rather than in a JWT, because a token that cannot be
 * revoked is a token that stays valid after an OWNER removes someone. The
 * cookie cache (P0-45) makes the common read cheap without giving that up: it
 * holds a signed copy for a short TTL, and anything sensitive re-reads here.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),

    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),

    /** The session token as presented in the cookie. */
    token: text('token').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('auth_sessions_token_unique').on(table.token),

    /** Every authenticated request looks a session up by token, so this is hot. */
    index('auth_sessions_user_idx').on(table.userId),

    /** For the expiry sweep, which scans by time rather than by user. */
    index('auth_sessions_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * `auth_accounts` — credentials and linked providers.
 *
 * One row per provider per user, including the email/password credential
 * itself, which is why `password` lives here rather than on `auth_users`.
 */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),

    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),

    /** The provider's own id for this user. */
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),

    /**
     * What actually identifies an account, as of Better Auth 1.7 (P0-45).
     *
     * `createLocalAccountIssuer('credential')` for email/password;
     * `createOAuthAccountIssuer(provider.id)` — the OIDC issuer — for the rest.
     * It exists because `provider_id` is not specific enough: one generic-OAuth
     * provider can front several issuers (two Keycloak realms, two Okta orgs),
     * and the same `account_id` in each is a *different person*.
     *
     * Required, and not in the P0-23a spec, which predates the 1.7 change.
     */
    issuer: text('issuer').notNull(),

    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    scope: text('scope'),

    /** The argon2 hash for the credential provider. Never the password itself. */
    password: text('password'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One account per *issuer* per external id — not per provider.
     *
     * P0-23a keyed this on `(provider_id, account_id)`, which is too strict now
     * that `issuer` exists: it would reject the same `account_id` arriving from
     * two Keycloak realms behind one provider, which are two different people.
     * `(issuer, account_id)` is the pair Better Auth 1.7 actually looks accounts
     * up by (`internalAdapter.findAccountByKey`), so it is the pair the database
     * should enforce.
     */
    unique('auth_accounts_issuer_account_unique').on(table.issuer, table.accountId),

    index('auth_accounts_user_idx').on(table.userId),
  ],
);

/**
 * `auth_verifications` — short-lived tokens for email verification and password
 * reset.
 *
 * **Not in the P0-23a spec, and required anyway.** The spec names four tables;
 * Better Auth will not start without this one, because email verification and
 * password reset both write to it. Discovering that at P0-45 would mean a
 * migration in the middle of wiring auth, so it lands here with the rest.
 */
export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),

    /** What is being verified — an email address, usually. */
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('auth_verifications_identifier_idx').on(table.identifier),
    index('auth_verifications_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * `auth_two_factor` — TOTP secrets and backup codes, for P4-11's OWNER MFA.
 *
 * Present from the start because adding it later is a data migration against a
 * table holding secrets, which is the least pleasant kind.
 */
export const authTwoFactor = pgTable(
  'auth_two_factor',
  {
    id: text('id').primaryKey(),

    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),

    /** The TOTP shared secret. Encrypted by Better Auth before it arrives. */
    secret: text('secret').notNull(),

    /** Hashed, never plain: a backup code is a password with a short life. */
    backupCodes: text('backup_codes').notNull(),

    /**
     * The three fields below are the plugin's own, and they are the reason
     * P0-45 needed a migration despite P0-23a creating this table (P0-45).
     *
     * `verified` distinguishes a secret that has been proven against a real
     * code from one merely generated — enrolling without it means a user can
     * lock themselves out with a misconfigured authenticator app.
     *
     * `failedVerificationCount` and `lockedUntil` are the plugin's brute-force
     * guard. A six-digit TOTP is 10^6 codes with a ±1-step window, which is
     * guessable at speed without a lockout, so these are load-bearing rather
     * than bookkeeping.
     */
    verified: boolean('verified').notNull().default(true),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('auth_two_factor_user_idx').on(table.userId)],
);
