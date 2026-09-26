import { randomUUID } from 'node:crypto';

import type { MembershipReader } from '@catalogorosso/core';
import { publicRoute, requires, ROLES, type RouteAccess } from '@catalogorosso/security';
import {
  acceptInviteResponse,
  catalogueReindexedResponse,
  contextResponse,
  importPreviewResponse,
  domainAddedResponse,
  domainRemovedResponse,
  domainVerifiedResponse,
  invitationRevokedResponse,
  issuedKeysResponse,
  keysResponse,
  inviteResponse,
  meResponse,
  memberRemovedResponse,
  pendingInvitationsResponse,
  productArchivedResponse,
  productCreatedResponse,
  productListResponse,
  productReindexedResponse,
  productUpdatedResponse,
  productsImportedResponse,
  ragSimulationResponse,
  roleChangeResponse,
  rosterResponse,
  surfaceResponse,
} from '@catalogorosso/api-client';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';

import {
  assertMemberWriteSucceeded,
  COMPLETENESS_BANDS,
  COMPLETENESS_FIELDS,
  ConflictError,
  IMPORT_TIME_BUDGET_MS,
  InvalidRequestError,
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_ROWS,
  NotFoundError,
  rangeOfBand,
  readVariantId,
  VARIANT_ID_EXPECTED,
  VERIFY_METHODS,
} from '@catalogorosso/core';
import {
  EMBEDDING_STATES,
  IMPORT_CLAIM_EXPIRES_AFTER_SECONDS,
  isSortField,
  MAX_LIMIT,
  productInsert,
  productUpdate,
  STOCK_STATUSES,
  type ProductInsert,
} from '@catalogorosso/db';

import type { AppEnv } from '../env.js';
import { mountAuthRoutes, requireUser, type AuthPort } from '../middleware/auth.js';
import { requireCapability, routeKey } from '../middleware/capability.js';
import { logger } from '../middleware/logger.js';
import { resolveTenant } from '../middleware/tenant.js';
import { unconfiguredDomains, type DomainsPort } from '../domains.js';
import { unconfiguredKeys, type KeysPort } from '../keys.js';
import { unconfiguredMembers, type MembersPort } from '../members.js';
import {
  countImportOutcomes,
  IMPORT_ENTRY_POINTS,
  importRequestHash,
  toProductResponse,
  unconfiguredProducts,
  type ProductsPort,
} from '../products.js';
import { unconfiguredRag, type RagPort } from '../rag.js';
import { AUTH_ROUTE_PREFIX, DASHBOARD_PREFIX } from '../routes.js';

/**
 * The dashboard surface — `/v1/dashboard/*` (P0-54, P0-45).
 *
 * Everything a signed-in seller does. Cookie-authenticated (P0-45),
 * tenant-scoped from `memberships` (P0-47), capability-checked (P0-49).
 *
 * **Its middleware stack must never reach the widget surface**, which is why
 * this is a separate `Hono` instance rather than a route group on a shared one.
 * Middleware registered on a parent app runs for every child, so the Better
 * Auth handler mounted below would sit in front of the public widget endpoints
 * too — and the widget deliberately accepts no cookies at all (§3.4, P2-08 sets
 * `Access-Control-Allow-Credentials: false`). Two instances make that
 * structural instead of a thing reviewers have to notice.
 */
export interface DashboardOptions {
  readonly auth: AuthPort;
  /** Reads the caller's memberships, under RLS. See `src/memberships.ts`. */
  readonly readMemberships: MembershipReader;
  /**
   * Invitations (P0-51). Optional, unlike `auth`, and the asymmetry is
   * deliberate: an absent `auth` would serve the dashboard *unauthenticated* —
   * silently permissive, and undetectable downstream — while an absent members
   * port refuses every call with a wiring error. Loud and total beats quiet and
   * open, so this one is allowed a default and that one is not.
   */
  readonly members?: MembersPort | undefined;

  /**
   * The catalogue (P1-02). Optional on the same terms as `members`: absent
   * refuses every call with a wiring error rather than answering plausibly.
   */
  readonly products?: ProductsPort | undefined;

  /**
   * The retrieval sandbox (P2-37). Optional on the `products` terms: absent
   * refuses every call with a wiring error rather than reporting an empty
   * candidate list, which a merchant would read as "retrieval found nothing".
   */
  readonly rag?: RagPort | undefined;

  /**
   * Domains (P4-01). Optional on the same terms as the rest: absent refuses
   * every call with a wiring error. Answering plausibly would be worse here
   * than anywhere else on this surface, because a domain that appears to have
   * been added is a widget a seller believes is about to work.
   */
  readonly domains?: DomainsPort | undefined;

  /**
   * Keys (P4-09). Optional on the same terms as the rest: absent refuses every
   * call with a wiring error. Answering plausibly would be worse here than
   * anywhere else on this surface — a key that appears to have been issued is
   * a key a seller will paste into their server.
   */
  readonly keys?: KeysPort | undefined;
}

/**
 * A JSON body, or `null` when there is not one.
 *
 * `c.req.json()` rejects on a malformed or absent body, and an unhandled
 * rejection here would surface as a 500 for what is a client mistake. The
 * schema below then reports it as the 400 it is.
 */
const readJson = async (c: { req: { json: () => Promise<unknown> } }): Promise<unknown> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

/** `readJson` for a body already read as text, which the import measures first. */
const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

/**
 * An import's body, measured, parsed and shaped, or a refusal (P1-25, P1-27).
 *
 * **Measured in bytes before it is parsed.** In production the platform
 * refuses anything over 6 MB before this runs; the cap sits under that so the
 * refusal a caller reads is this one, which names the limit. Bytes rather than
 * characters: an accented letter is two of them, and a catalogue of Italian
 * tasting notes is full of them.
 *
 * Shared by the import and its preview (P1-23), so the summary screen is
 * refused for exactly what the import would be.
 */
const readImportBody = async <T>(
  c: { req: { text: () => Promise<string> } },
  schema: z.ZodType<T>,
  shape: string,
): Promise<T> => {
  const raw = await c.req.text();

  if (new TextEncoder().encode(raw).byteLength > MAX_IMPORT_BODY_BYTES) {
    throw new InvalidRequestError(
      `An import body may be at most ${String(MAX_IMPORT_BODY_BYTES / 1024 / 1024)} MB. ` +
        'Split the rows into several imports, each with its own Idempotency-Key.',
    );
  }

  const body = schema.safeParse(parseJson(raw));

  if (!body.success) {
    throw new InvalidRequestError(
      `Send a JSON body of the form ${shape} carrying between 1 and ${String(MAX_IMPORT_ROWS)} products.`,
    );
  }

  return body.data;
};

/**
 * The Shopify variant id, normalised on the way in (P3-11).
 *
 * **`/cart/add.js` accepts only the numeric form**, and a seller pastes
 * whichever their export gave them. A GID stored unnoticed produces a wine that
 * looks correctly configured in the console and silently fails at the moment a
 * visitor presses *Aggiungi al carrello* — the worst place to find out, and
 * one nobody would connect back to an import three weeks earlier.
 *
 * `undefined` means the value was neither shape, which fails the row.
 */
const normalisedVariant = (row: ProductInsert): ProductInsert | undefined => {
  const variant = readVariantId(row.externalVariantId);

  if (variant === undefined) return row;
  if (!variant.ok) return undefined;

  return { ...row, externalVariantId: variant.id };
};

/**
 * Every row checked against the product contract, or the whole request refused (P1-25).
 *
 * `productInsert` strips what it does not know, `tenantId` included, so a row
 * carrying one parses with the field discarded (P0-42, P0-48): the tenant comes
 * from the membership and nowhere else.
 */
const contractRows = (candidates: readonly unknown[]): ProductInsert[] => {
  const rows: ProductInsert[] = [];
  const invalid: number[] = [];

  candidates.forEach((row, index) => {
    const parsed = productInsert.safeParse(row);

    if (!parsed.success) {
      invalid.push(index + 1);

      return;
    }

    const variant = normalisedVariant(parsed.data);

    if (variant === undefined) invalid.push(index + 1);
    else rows.push(variant);
  });

  if (invalid.length > 0) {
    const named = invalid.slice(0, 5).join(', ');
    const more = invalid.length > 5 ? ` and ${String(invalid.length - 5)} more` : '';

    throw new InvalidRequestError(
      `Row ${named}${more} did not match the product contract, so nothing was imported. ` +
        'Validate every row before sending an import.',
    );
  }

  return rows;
};

/**
 * The header naming one import attempt (P1-26).
 *
 * The name the IETF draft and Stripe use, so a client that already sends it on
 * retries has nothing to learn. Required rather than optional: an optional key
 * is the key the one client that double-submits forgets to send.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * The bulk import body. Rows are `unknown` here and checked one by one below,
 * so a refusal can say *which* rows broke the contract rather than that the
 * body did.
 */
/**
 * Where an import's rows came from (P1-28), recorded by its audit entry.
 *
 * Required: an entry that cannot say whether 400 prices arrived by paste or by
 * file answers half the question it exists for. The file name is the seller's
 * own and optional — a paste and a form have none — and capped at what a file
 * system allows. Strict, so a client cannot slip a path or anything else in.
 */
const importSource = z
  .object({
    entryPoint: z.enum(IMPORT_ENTRY_POINTS),
    filename: z.string().min(1).max(255).optional(),
  })
  .strict();

const importBody = z
  .object({ rows: z.array(z.unknown()).min(1).max(MAX_IMPORT_ROWS), source: importSource })
  .strict();

/** The preview's body: the rows alone, since nothing is claimed or audited (P1-23). */
const importPreviewBody = z
  .object({ rows: z.array(z.unknown()).min(1).max(MAX_IMPORT_ROWS) })
  .strict();

const IMPORT_SHAPE =
  '{ "rows": [...], "source": { "entryPoint": "form" | "paste" | "file", "filename"?: "..." } }';
const PREVIEW_SHAPE = '{ "rows": [...] }';

/**
 * 320 is the practical maximum length of an address (64 local + @ + 255
 * domain). A bound rather than no bound, because this string is written into a
 * row and into an email subject.
 */
const inviteBody = z.object({
  email: z.string().min(3).max(320),
  role: z.enum(ROLES),
});

/**
 * The role-change body (E8).
 *
 * `.strict()` for the same reason the acceptance body is: an unexpected field
 * should be a rejection the operator can see, not a value silently dropped. The
 * target is in the *path*, never here — a body carrying both a `userId` and a
 * `role` is one refactor away from somebody reading the wrong one.
 */
const roleChangeBody = z.object({ role: z.enum(ROLES) }).strict();

/**
 * The acceptance body, and what it does **not** carry.
 *
 * There is no `role` here, and its absence is the row's central requirement:
 * the acceptance payload is written by the person who benefits from a higher
 * role, so reading one from it is self-service escalation with an audit trail
 * that looks legitimate. `.strict()` makes a sent one a 400 rather than a
 * silently ignored field, so an attempt shows up as a rejection instead of
 * looking like it worked.
 */
const acceptBody = z.object({ token: z.string().min(16).max(256) }).strict();

/**
 * The catalogue list query (P1-06).
 *
 * **Every value is validated before it reaches a query builder**, and the sort
 * field most of all: it is the one parameter that names a *column*, and the
 * allowlist in `packages/db` is what stops a client-supplied string ever
 * reaching the planner. Checking it here as well means an unknown field is a
 * 422 naming the parameter rather than a silent fall back to the default —
 * which would leave a caller convinced they were sorting by something.
 *
 * The limit is clamped rather than rejected. A caller asking for a thousand
 * rows wants as many as they can have; refusing them is unhelpful where
 * answering with a hundred is exactly right, and `nextCursor` tells them there
 * is more.
 */
const listQuery = z.object({
  /**
   * The search phrase (P1-08).
   *
   * Bounded, because it is interpolated into a `tsquery` parse and a trigram
   * comparison — neither of which is injectable, both of which are work
   * proportional to its length. A 10,000-character "search" is a cheap way to
   * make the database do something expensive.
   */
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  sort: z.string().refine(isSortField, 'not a sortable field').optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().min(1).max(512).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),

  /* ---- filters (P1-09) ------------------------------------------------- */

  stockStatus: z.enum(STOCK_STATUSES).optional(),
  embeddingState: z.enum(EMBEDDING_STATES).optional(),

  /**
   * **Not a Zod enum, and the row's instruction cannot be followed here.**
   * `wine_type` is `text` rather than an enum in the schema (P0-26), because
   * the taxonomy grows sideways — orange, pét-nat, col fondo — and each
   * addition would otherwise be an `ALTER TYPE` for a label that guards
   * nothing. Enumerating it here would reintroduce exactly that coupling one
   * layer up, and the failure would be a filter that silently rejects a wine
   * type the catalogue already contains.
   */
  wineType: z.string().trim().min(1).max(64).optional(),

  /**
   * A grape the wine must contain.
   *
   * **This one is not a convenience.** Free-text search cannot find by grape —
   * `array_to_string` is `STABLE`, so the array could not be folded into the
   * generated tsvector (P1-07) — so "find me a nebbiolo" has nowhere else to
   * go. Matched exactly, against the array GIN index.
   */
  grape: z.string().trim().min(1).max(64).optional(),

  priceMin: z.coerce.number().int().nonnegative().optional(),
  priceMax: z.coerce.number().int().nonnegative().optional(),

  /**
   * How completely a wine is described (P1-09, which deferred this to P1-12).
   *
   * **A band rather than a number**, because the number is not the seller's
   * unit. Nobody asks for "wines scoring under 40"; they ask to see the ones
   * that need work, which is what the indicator beside each row already calls
   * *Da completare*. Taking a raw range here would let a client invent a
   * fourth band the interface has no word for.
   */
  completeness: z.enum(COMPLETENESS_BANDS).optional(),
});

/**
 * What a merchant asks the sandbox (P2-37).
 *
 * **`.strict()`**, unlike the product bodies: every field here is a knob on a
 * diagnostic, and a misspelt one that parses cleanly would report on a run
 * nobody asked for. A sweep silently using the default cap is the failure.
 *
 * **The price ceiling arrives structured**, never inferred from the question
 * (P2-21). The whole point of a diagnostic is that its inputs are known.
 */
const simulationRequest = z
  .object({
    query: z.string().trim().min(1).max(500),
    maxPriceCents: z.number().int().nonnegative().optional(),
    cap: z.number().int().nonnegative().max(40).optional(),
  })
  .strict();

/**
 * What a seller types into the domains screen.
 *
 * Deliberately just a string with a length ceiling. Every rule about what an
 * origin may be lives in `normalizeOrigin` (P2-05), and a `z.url()` here would
 * be a second, weaker authority that refuses `winery.com` — which is what a
 * seller will actually type.
 */
const domainBody = z.object({ domain: z.string().min(1).max(300) }).strict();

/**
 * `Cache-Control: no-store` on the way out (P4-09).
 *
 * Set after the handler runs, so it lands on the response actually sent —
 * including a refusal, which is harmless to cache but is not worth a rule
 * with an exception in it.
 */
const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};

/**
 * Which proof a seller is offering.
 *
 * **Their choice, and the list is closed.** DNS is not always theirs to change
 * — plenty would have to ask whoever built the site — and a file on the
 * storefront is. Derived from `VERIFY_METHODS` so a third proof cannot be added
 * to the domain rules and silently not reach the route.
 */
const verifyBody = z.object({ method: z.enum(VERIFY_METHODS) }).strict();

export const createDashboardApp = ({
  auth,
  readMemberships,
  members = unconfiguredMembers,
  products = unconfiguredProducts,
  rag = unconfiguredRag,
  domains = unconfiguredDomains,
  keys = unconfiguredKeys,
}: DashboardOptions): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  /*
   * ---- Public on this surface -------------------------------------------
   *
   * Registered above the guard, and that is load-bearing rather than
   * stylistic: Hono matches handlers in registration order and stops at the
   * first that responds, so anything here is reached without a session. Sign-in
   * cannot require a session, which is the whole reason the order exists.
   */

  /*
   * A surface marker, and the probe P0-46's surface-isolation group hangs off.
   * It reports which stack served the request, so a test can prove *which* app
   * answered rather than only that something did — the distinction that matters
   * when the bug being hunted is one surface answering for the other.
   */
  app.get('/', (c) => c.json({ surface: 'dashboard' as const }));

  /** Sign-in, sign-up, reset, verification, TOTP — all of Better Auth. */
  mountAuthRoutes(app, auth, AUTH_ROUTE_PREFIX);

  /*
   * ---- Everything below this line requires a session ---------------------
   *
   * A route added *above* this call is public, silently, and its own tests
   * would all still pass. `auth.test.ts` asserts both halves of the boundary:
   * that `/auth/*` is reachable without a session, and that a route registered
   * after the guard is not.
   */
  app.use('*', requireUser(auth));

  /**
   * Who the caller is, and which wineries they belong to.
   *
   * **Above tenant resolution, deliberately.** A user with more than one
   * membership has to pick one, and they cannot pick from a list they are not
   * allowed to fetch — so this route has to work without an active tenant. It
   * is the dashboard shell's bootstrap call (P0-57).
   *
   * It reports no role at top level, on purpose. A role belongs to a
   * membership, not to a user, and a `role` field beside `userId` is the shape
   * that invites somebody to cache it per user and hand an EDITOR on one
   * winery OWNER powers on another.
   */
  app.get('/me', async (c) => {
    const memberships = await readMemberships(c.get('userId'));

    return c.json({ userId: c.get('userId'), memberships });
  });

  /**
   * Redeem an invitation.
   *
   * **Above tenant resolution, and that is structural rather than tidy.** The
   * caller is not yet a member of the winery they are joining — becoming one is
   * what this request does — so `resolveTenant` would refuse them before the
   * handler ran. Moving this route below that middleware makes accepting an
   * invitation impossible for exactly the people it exists for, and every test
   * written against a caller who is already a member would still pass.
   *
   * The tenant comes from the invitation row, matched by a 256-bit token, and
   * is set inside the same transaction (`withInvitation`). So the P0-48
   * invariant holds on a path that has no membership to read it from: the value
   * still comes out of Postgres rather than off the wire.
   */
  app.post('/members/accept', async (c) => {
    const parsed = acceptBody.safeParse(await readJson(c));

    if (!parsed.success) {
      throw new InvalidRequestError('Send a JSON body carrying the invitation token.');
    }

    const membership = await members.accept({
      token: parsed.data.token,
      userId: c.get('userId'),
    });

    /*
     * One answer for every failure — unknown token, expired, revoked, already
     * redeemed, addressed to somebody else. Distinguishing them would turn this
     * into an oracle for testing which tokens exist and which addresses have
     * open invitations, and none of the distinctions helps a legitimate caller,
     * who either has a working link or needs a new one either way.
     */
    if (!membership) throw new NotFoundError('That invitation link is not usable.');

    return c.json(membership);
  });

  /*
   * ---- Everything below this line is scoped to one winery ----------------
   *
   * `tenantId` and `role` come from a single `memberships` row and are the only
   * source a handler may use. A route added above this call has no tenant, and
   * a `c.get('tenantId')` in it is undefined at runtime while typechecking
   * perfectly — which is why the routes that need one live below.
   */
  app.use('*', resolveTenant(readMemberships));

  /**
   * The active winery, as resolved — not as requested.
   *
   * Small, and it earns its place: it is the assertion P0-48 hangs off. A test
   * signs in as a member of tenant A, sends `x-active-tenant: B`, and reads the
   * effective tenant back from here — an assertion on returned data rather than
   * on a mock.
   */
  app.get('/context', requireCapability('catalog:read'), (c) =>
    c.json({ tenantId: c.get('tenantId'), role: c.get('role') }),
  );

  /**
   * Invite somebody to this winery.
   *
   * The role *is* read from the request here, and that is not a contradiction
   * of the rule the acceptance route follows. The caller holds
   * `members:manage`, which only an OWNER has, so choosing the role is exactly
   * their authority. What must never be read from a request is the role at
   * **acceptance**, where the sender is the person who benefits from it.
   */
  app.post('/members/invite', requireCapability('members:manage'), async (c) => {
    const parsed = inviteBody.safeParse(await readJson(c));

    if (!parsed.success) {
      throw new InvalidRequestError('Send a JSON body carrying an email and a role.');
    }

    const result = await members.invite({
      tenantId: c.get('tenantId'),
      email: parsed.data.email,
      role: parsed.data.role,
      invitedBy: c.get('userId'),
    });

    /*
     * The same 200 whether or not a row was created, with `created` saying
     * which. Re-inviting is a no-op rather than an error because the owner's
     * intent — "make sure this person can get in" — is already satisfied, and
     * answering 409 to it produces a dashboard that has to explain a conflict
     * that is not one.
     *
     * The port distinguishes three reasons for `false` — already a member,
     * already invited, and undeliverable because the address is suppressed
     * (P0-64) — and this response flattens them. That is a deliberate hold
     * rather than an oversight: the members screen (E8) is what will have
     * somewhere useful to show the reason, and widening the contract before
     * there is a reader for it means guessing at the shape.
     */
    return c.json({
      email: parsed.data.email,
      created: result.created,
      outcome: result.outcome,
    });
  });

  /* ---- the catalogue (P1-02) ------------------------------------------ */

  /**
   * Create a product.
   *
   * **The transaction shape every later write copies.** The product row and its
   * outbox row commit together or not at all (§4.1) — a committed product with
   * no queued embedding job is invisible to search, and the seller sees a
   * catalogue that silently lacks it: no error, no failed job, nothing to
   * retry. `insertProduct` writes both, which is why it is one call rather than
   * two made in order here.
   *
   * **No audit row, and that is a decision rather than an omission.** P1-28
   * audits an *import*, which is one deliberate act over hundreds of rows.
   * A row per product save would bury the entries that matter — a role change,
   * a member removal — under ordinary catalogue churn, and an audit log nobody
   * can read is worse than a smaller one.
   */
  app.post('/products', requireCapability('catalog:write'), async (c) => {
    /*
     * **Not `.strict()`, unlike the member bodies above, and the difference is
     * about who is sending.** P0-42 omits `tenant_id`, `id` and the timestamps
     * from this contract, and zod strips what it does not know — so a body
     * carrying `tenantId` parses cleanly with the field discarded, and the
     * field is not merely ignored but unrepresentable in the resulting type.
     * Strictness would add nothing there and would break the paste and file
     * import paths (P1-14, P1-16), which arrive carrying whatever columns a
     * seller's spreadsheet had.
     */
    const parsed = productInsert.safeParse(await readJson(c));

    if (!parsed.success) {
      throw new InvalidRequestError('Send a JSON body describing a product.');
    }

    /* Same normalisation as the import path, for the same reason (P3-11). */
    const values = normalisedVariant(parsed.data);

    if (values === undefined) throw new InvalidRequestError(VARIANT_ID_EXPECTED);

    const result = await products.create({
      /*
       * From a `memberships` row, never from the body (P0-48). The contract
       * makes the alternative impossible rather than merely discouraged.
       */
      tenantId: c.get('tenantId'),
      values,
    });

    if (result.outcome === 'duplicate-sku') {
      /*
       * 409 and not 404, and the message names the SKU's role rather than the
       * constraint. A SKU is the seller's own identifier — they are entitled to
       * know it is taken, because they are the one who chose it, and this is
       * not a cross-tenant probe: the uniqueness is scoped to their winery, so
       * the answer discloses nothing about anybody else's catalogue.
       */
      throw new ConflictError(
        `A product with SKU "${parsed.data.sku}" already exists in this catalogue. ` +
          'Edit that one, or choose a different SKU.',
      );
    }

    /*
     * Projected, never returned verbatim. The row carries `content_hash` and
     * `tenant_id`, and neither is in the published contract — see
     * `toProductResponse`.
     */
    return c.json(toProductResponse(result.product), 201);
  });

  /**
   * Import many wines at once (P1-25).
   *
   * **The whole request is refused if any row breaks the contract**, before
   * anything is written. The dashboard validates every row against the same
   * contract before sending (P1-22), so a row that fails here is a client that
   * skipped that step — and applying the rest would leave a seller with a
   * catalogue that is partly the file they chose and partly not.
   *
   * **A failure part-way through is reported, not thrown.** Batches commit one
   * at a time, so the answer says how far the import got; the cause is logged
   * and never sent, because a driver error can carry a connection string or
   * another tenant's value (P0-55).
   *
   * `EDITOR`s may import: `catalog:write` is theirs, and keeping a catalogue up
   * to date is the job the role exists for (§2.7).
   */
  /**
   * What an import would do, before it does anything (P1-23).
   *
   * **The confirm gate's other half.** The summary screen's nuovi, aggiornati
   * and invariati come from here, because the client cannot compute them: it
   * does not have the stored rows. Same body refusals, same duplicate rule, same
   * `planUpsert` as the import, so the two disagree only when the catalogue
   * changed between them. No key and no audit entry: it changes nothing.
   *
   * `catalog:write`, not `catalog:read`: it exists only as the first step of an
   * import, and a role that cannot import has nothing to confirm.
   */
  app.post('/products/import/preview', requireCapability('catalog:write'), async (c) => {
    const body = await readImportBody(c, importPreviewBody, PREVIEW_SHAPE);
    const outcomes = await products.previewRows({
      tenantId: c.get('tenantId'),
      rows: contractRows(body.rows),
    });

    return c.json({ outcomes, counts: countImportOutcomes(outcomes) });
  });

  app.post('/products/import', requireCapability('catalog:write'), async (c) => {
    /*
     * Taken before anything else, so the budget covers reading and validating
     * up to 5 MB of rows as well as the batches (review fix).
     */
    const deadline = Date.now() + IMPORT_TIME_BUDGET_MS;

    /*
     * The key is checked first and claimed last. First, so a request without
     * one is refused before ten thousand rows are parsed. Last, so a request
     * refused for a broken row uses nothing up: the seller fixes the row and
     * sends the same key again, and that is still the same attempt.
     */
    const idempotencyKey = z.uuid().safeParse(c.req.header(IDEMPOTENCY_KEY_HEADER));

    if (!idempotencyKey.success) {
      throw new InvalidRequestError(
        `Send an ${IDEMPOTENCY_KEY_HEADER} header carrying a UUID generated for this import, ` +
          'and send the same UUID again if you retry it.',
      );
    }

    const body = await readImportBody(c, importBody, IMPORT_SHAPE);
    const rows = contractRows(body.rows);

    const tenantId = c.get('tenantId');
    const claim = await products.claimImport({
      tenantId,
      idempotencyKey: idempotencyKey.data,
      requestHash: importRequestHash(rows),
    });

    /*
     * **A repeat answers with the first attempt's body, not a fresh run's.**
     * The import is an upsert, so running it again would report every row
     * `unchanged`: true of the catalogue, false of the attempt, and the seller
     * who double-clicked would read "0 nuovi" for the wines they just added.
     */
    if (claim.outcome === 'replay') return c.json(claim.result);

    if (claim.outcome === 'different-body') {
      throw new ConflictError(
        `This ${IDEMPOTENCY_KEY_HEADER} was already used for an import with different rows. ` +
          'Generate a new key for each import.',
      );
    }

    if (claim.outcome === 'in-progress') {
      throw new ConflictError(
        `The import sent with this ${IDEMPOTENCY_KEY_HEADER} has not finished. Retry with the ` +
          'same key shortly to read its result; an attempt that never finishes is released ' +
          `after ${String(IMPORT_CLAIM_EXPIRES_AFTER_SECONDS)} seconds.`,
      );
    }

    const result = await products.importRows({ tenantId, rows, deadline });

    if (result.stoppedAt?.reason === 'failed') {
      logger.error(
        { err: result.stoppedAt.cause },
        `a product import stopped at batch ${String(result.stoppedAt.batch)} (P1-25)`,
      );
    } else if (result.stoppedAt?.reason === 'time-budget') {
      /*
       * Not an error: the import is doing what it should with a catalogue too
       * large for one request. Logged so a budget that stops *every* import
       * shows up as a pattern, rather than as sellers reporting slow imports.
       */
      logger.info(
        `a product import used its time budget and stopped before batch ${String(result.stoppedAt.batch)}`,
      );
    }

    const counts = countImportOutcomes(result.outcomes);
    const response = {
      outcomes: result.outcomes,
      counts,
      stoppedAt:
        result.stoppedAt === null
          ? null
          : {
              batch: result.stoppedAt.batch,
              fromRow: result.stoppedAt.fromIndex + 1,
              toRow: result.stoppedAt.toIndex + 1,
              reason: result.stoppedAt.reason,
            },
    };

    /*
     * Stored even when the import stopped part-way: how far it got *is* this
     * attempt's answer. Resuming is a new attempt with a new key, and the rows
     * already applied come back unchanged (P1-25). The cause stays in the log
     * above and never reaches the stored body, which a replay would return.
     */
    /*
     * **One audit entry, and only when a row reached the catalogue** (P1-28).
     * "Who replaced 400 prices?" is the question it answers, so an import that
     * failed in its first batch, or refused every row as a duplicate, changed
     * nothing and records nothing. Unchanged rows count as reaching it: the
     * seller did import them, and "nothing changed" is an answer too.
     */
    const reachedCatalogue = counts.created + counts.updated + counts.unchanged > 0;

    await products.completeImport({
      tenantId,
      runId: claim.runId,
      result: response,
      audit: reachedCatalogue
        ? {
            idempotencyKey: idempotencyKey.data,
            entryPoint: body.source.entryPoint,
            filename: body.source.filename,
            counts,
          }
        : null,
    });

    return c.json(response);
  });

  /**
   * Edit a wine.
   *
   * **`PATCH`, and the outbox row is conditional — this is where the cost
   * control actually lives.** A seller correcting stock or fixing a price edits
   * rows constantly, and embedding every one of those is a bill that tracks how
   * often people use the product rather than what is in it. The comparison is
   * against the stored hash, inside the same transaction that holds the row
   * locked, so two concurrent patches cannot both compute from the same base.
   *
   * **A cross-tenant id answers 404, not 403** (§3.5) — and it does so because
   * RLS scoped the read to nothing rather than because a branch says so. That
   * is the safer arrangement: the natural hand-written version compares the
   * row's tenant to the caller's and returns 403, which tells an attacker the
   * resource exists.
   */
  app.patch('/products/:id', requireCapability('catalog:write'), async (c) => {
    const parsed = productUpdate.safeParse(await readJson(c));

    if (!parsed.success) {
      throw new InvalidRequestError('Send a JSON body with the product fields to change.');
    }

    const result = await products.update({
      tenantId: c.get('tenantId'),
      productId: c.req.param('id'),
      values: parsed.data,
    });

    if (result.outcome === 'not-found') {
      /*
       * One answer for an id that never existed, one that belongs to another
       * winery, and one that is not a uuid at all. Distinguishing them would
       * tell a caller which ids are real.
       */
      throw new NotFoundError('No such product.');
    }

    if (result.outcome === 'duplicate-sku') {
      throw new ConflictError(
        'Another product in this catalogue already uses that SKU. ' +
          'Edit that one, or choose a different SKU.',
      );
    }

    /*
     * No `reindexed` field in the response, deliberately: `embeddingState`
     * already carries it. A re-embedding edit leaves the row `STALE` — findable
     * under its previous description while the new one is built — and P1-40's
     * grid renders that state directly. A second field saying the same thing is
     * a second thing to keep true.
     */
    return c.json(toProductResponse(result.product));
  });

  /**
   * Remove a wine from the catalogue.
   *
   * **Two different kinds of delete, deliberately.** The row is archived rather
   * than deleted, because an order placed last month refers to it and a
   * catalogue that forgets what it sold cannot answer a customer's question
   * about their own purchase. The vectors are deleted outright, because a
   * vector is not history — it is the thing retrieval searches, so leaving it
   * means the wine keeps being recommended after the seller removed it.
   *
   * The response says the wine will no longer be recommended, which is the
   * property the seller cares about and a different claim from "the row is
   * gone". P1-05 asserts it through the real retrieval path rather than by
   * counting rows, because an empty vectors table and an unretrievable product
   * are not the same statement.
   */
  app.delete('/products/:id', requireCapability('catalog:write'), async (c) => {
    const result = await products.archive({
      tenantId: c.get('tenantId'),
      productId: c.req.param('id'),
    });

    if (result.outcome === 'not-found') throw new NotFoundError('No such product.');

    return c.json({
      id: result.product.id,
      status: 'ARCHIVED' as const,
      noLongerRecommended: true as const,
      vectorsRemoved: result.vectorsRemoved,
    });
  });

  /**
   * One page of the catalogue.
   *
   * **Keyset pagination, and the reason is correctness before it is speed.**
   * `OFFSET` degrades as a catalogue grows, but the failure that bites first is
   * that it is *wrong* when the data changes between pages: a row inserted
   * while somebody is paging shifts everything down by one, so page two repeats
   * a row page one already showed. On an import screen that is precisely when
   * the data is changing.
   *
   * Archived wines are hidden unless asked for. A seller who removed a wine
   * should not have to look at it; the row survives only so an order referring
   * to it still makes sense (P1-04), which is not a reason to show it.
   */
  app.get('/products', requireCapability('catalog:read'), async (c) => {
    const parsed = listQuery.safeParse(c.req.query());

    if (!parsed.success) {
      /*
       * Named rather than generic, because these are query parameters a person
       * typed into a URL or a client built wrong — and "sort" is the one worth
       * naming, since silently falling back to the default would leave a caller
       * convinced they were sorting by something.
       */
      throw new InvalidRequestError(
        'Check the query parameters: sort must be one of createdAt, updatedAt, name or ' +
          `priceCents, direction asc or desc, limit a whole number up to ${String(MAX_LIMIT)}, ` +
          'and stockStatus, embeddingState, completeness and the price bounds must be ' +
          'values the catalogue actually uses.',
      );
    }

    const { completeness, ...query } = parsed.data;

    const page = await products.list({
      tenantId: c.get('tenantId'),
      ...query,
      /*
       * **This layer is the join, and it is the only one that can be.** The
       * weights are a product decision and live in `packages/core`; the columns
       * are a schema fact and live in `packages/db`; `core` already depends on
       * `db`, so `db` cannot import the weights without a cycle. `apps/api`
       * imports both, so it hands one to the other — which keeps a single
       * definition of what a field is worth rather than a copy in SQL.
       */
      ...(completeness === undefined
        ? {}
        : {
            completeness: {
              ...rangeOfBand(completeness),
              weights: COMPLETENESS_FIELDS.map(([field, weight]) => ({ field, weight })),
            },
          }),
    });

    return c.json({
      items: page.items.map(toProductResponse),
      nextCursor: page.nextCursor,
      /*
       * `column` is not a *match* — it is the absence of a search — so it
       * reports as `null` rather than as a third mode. A client should not have
       * to know that listing and searching share an implementation.
       */
      matchedBy:
        page.matchedBy === 'column' ? null : page.matchedBy === 'text' ? 'exact' : 'similar',
    });
  });

  /**
   * Re-queue the whole active catalogue (P1-39).
   *
   * **Registered before `/products/:id/reindex` and it has to be.** Hono
   * matches in registration order, and although these two paths differ in
   * segment count today, the habit is what P0-54 is about: the day somebody
   * adds `POST /products/:id`, a literal registered after a parameter is a
   * route that silently stops being reachable while every one of its own tests
   * still passes.
   *
   * **409 while a previous run is still draining**, carrying how many jobs are
   * left. Two batches in the queue index nothing twice — they double the work
   * before either finishes, so the honest answer is "the last one is still
   * going" rather than a second acceptance that makes the wait longer.
   *
   * Archived wines are left alone. Re-embedding one would put it back in front
   * of visitors, which is the thing archiving means to stop.
   */
  app.post('/products/reindex-all', requireCapability('catalog:write'), async (c) => {
    const result = await products.reindexAll({
      tenantId: c.get('tenantId'),

      /*
       * Generated here rather than in the port, so the layer that owns
       * non-determinism is the one that has always owned it — and a test of the
       * port can supply its own id instead of mocking a global.
       */
      batchId: randomUUID(),
    });

    if (result.outcome === 'in-flight') {
      throw new ConflictError(
        `A reindex is already running for this catalogue, with ${String(result.queued)} ` +
          'wine(s) still queued. Wait for it to finish rather than starting a second one — ' +
          'two runs do not index anything twice, they only make the wait longer.',
      );
    }

    return c.json({ batchId: result.batchId, queued: result.queued }, 202);
  });

  /**
   * Re-queue one wine (P1-39).
   *
   * **What this fixes is a row and a vector disagreeing, not a stale
   * embedding.** A wine whose vector already matches its text costs no provider
   * call — `shouldEmbed` names "a manual reindex of an unchanged product" as
   * one of the things it exists to stop costing money (P1-34). The job still
   * runs, and the useful cases are the ones a seller can actually see: a
   * `FAILED` wine gets another attempt with its error cleared, a wine whose
   * outbox row was lost gets a new one, and a `PENDING` wine that does in fact
   * have a good vector is corrected to `INDEXED`.
   *
   * **A cross-tenant id answers 404** (§3.5), and does so because the policy
   * scoped the read to nothing rather than because a branch compared two tenant
   * ids.
   *
   * **An archived wine is refused rather than quietly accepted.** The worker
   * discards its job by design, so a 202 here would tell a seller something was
   * happening when nothing was going to.
   */
  app.post('/products/:id/reindex', requireCapability('catalog:write'), async (c) => {
    const result = await products.reindex({
      tenantId: c.get('tenantId'),
      productId: c.req.param('id'),
    });

    if (result.outcome === 'not-found') throw new NotFoundError('No such product.');

    if (result.outcome === 'archived') {
      throw new ConflictError(
        'This wine is archived, so it is not indexed and reindexing it would do nothing. ' +
          'Restore it first if it should be recommended again.',
      );
    }

    return c.json({ product: toProductResponse(result.product), queued: true as const }, 202);
  });

  /* ---- the retrieval sandbox (P2-37) ----------------------------------- */

  /**
   * Run the real retrieval path and show its working.
   *
   * **`catalog:read`, because what it returns is the catalogue** — the wines
   * that matched, in the order they matched, with the numbers that put them
   * there. Nothing here is written, so a write capability would be asking for
   * a permission the endpoint does not use.
   *
   * **It is the same code the widget runs**, not a reimplementation of it: one
   * embedding, the fused statement, P2-21's filter, P2-22's cap. A sandbox
   * that ran its own version would answer questions about itself, which is the
   * one thing a diagnostic must not do.
   *
   * **No usage, no analytics, no conversation.** A merchant debugging a bad
   * recommendation clicks this repeatedly, and every click that moved a counter
   * would corrupt the analytics they are about to look at next.
   *
   * **No system prompt in the response**, only a hash of it. Returning the
   * assembled prompt would hand our instructions to every tenant (§3.7); the
   * hash is enough for support to confirm which version ran.
   */
  app.post('/rag/simulate', requireCapability('catalog:read'), async (c) => {
    const parsed = simulationRequest.safeParse(await readJson(c));

    if (!parsed.success) {
      throw new InvalidRequestError(
        'Send a JSON body with a query, and optionally maxPriceCents or cap.',
      );
    }

    return c.json(
      await rag.simulate({
        /* From a `memberships` row, never from the body (P0-48). */
        tenantId: c.get('tenantId'),
        ...parsed.data,
      }),
    );
  });

  /* ---- the members screen (E8) ---------------------------------------- */

  /**
   * The roster.
   *
   * Behind `members:manage` rather than a read capability, and that is a
   * choice worth stating: who else can reach a winery's catalogue and billing
   * is not neutral information, and an `EDITOR` has no action to take on it.
   * It moves to a narrower capability the day there is a screen that needs it.
   */
  app.get('/members', requireCapability('members:manage'), async (c) =>
    c.json({ members: await members.roster(c.get('tenantId')) }),
  );

  /** Invitations still outstanding. Open ones only — see the port. */
  app.get('/members/invitations', requireCapability('members:manage'), async (c) =>
    c.json({ invitations: await members.pending(c.get('tenantId')) }),
  );

  /* ---- keys (P4-09) ----------------------------------------------------- */

  /**
   * Every response on these routes is `no-store`, not only the two that carry a
   * secret. A header that is right on some responses of a path and missing on
   * others is a header somebody forgets on the next route added here.
   */
  app.use('/keys/*', noStore);

  /** The keys, as far as the dashboard is ever allowed to know them. */
  app.get('/keys', requireCapability('keys:manage'), async (c) =>
    c.json(await keys.read(c.get('tenantId'))),
  );

  /**
   * Issue a winery's first keys.
   *
   * **The response carries the secret key, and it is the only time anything
   * will.** Behind `keys:manage`, which only an OWNER holds: the secret key is
   * what lets a server mint sessions on the winery's behalf (P4-10), and that is
   * closer to a password than to a setting.
   */
  app.post('/keys', requireCapability('keys:manage'), async (c) =>
    c.json(await keys.create(c.get('tenantId')), 201),
  );

  /**
   * Replace the secret key, effective immediately.
   *
   * No grace window — unlike the public key's (P4-08) — because a seller rotates
   * a secret when they think it has leaked, and a window in which the old one
   * still works is a window in which the leak still works. They control their
   * own server's deployment; the moment they rotate is the moment it changes.
   */
  app.post('/keys/secret/rotate', requireCapability('keys:manage'), async (c) =>
    c.json(await keys.rotateSecret(c.get('tenantId'))),
  );

  /**
   * Replace the public key, keeping the old one live for a day (P4-08).
   *
   * The grace exists because rotation cannot be atomic: the old key is in a
   * script tag on the seller's pages until they redeploy. A second rotation
   * ends the first one's grace, so at most one old key is ever live — a seller
   * rotates because they think a key has leaked, and rotating again must not
   * leave the first leaked key working beside the second.
   */
  app.post('/keys/public/rotate', requireCapability('keys:manage'), async (c) =>
    c.json(await keys.rotatePublic(c.get('tenantId'))),
  );

  /* ---- domains (P4-01) -------------------------------------------------- */

  /**
   * Remove a domain.
   *
   * **Immediate, and immediate in a way that survives a cache.** Today CORS
   * resolves the allowlist uncached on every request, so a removed origin is
   * refused before a token is read. §5.7 contemplates caching that, and the day
   * it does the immediacy would quietly become "within the TTL" — so the
   * removal also writes a per-origin session cutoff, which is what still works
   * then (P4-06).
   *
   * `confirm=true` is required only for the last **verified** domain, and it is
   * a confirmation rather than a refusal: it is their domain and their
   * decision, and what they must not be able to do is make it by accident.
   */
  app.delete('/domains/:id', requireCapability('domains:manage'), async (c) =>
    c.json(
      await domains.remove({
        /* From a `memberships` row, never from the body (P0-48). */
        tenantId: c.get('tenantId'),
        domainId: c.req.param('id'),
        confirmed: c.req.query('confirm') === 'true',
      }),
    ),
  );

  /**
   * Check a domain's proof.
   *
   * `POST` rather than `GET`, because it is not a read: it makes an outbound
   * DNS query on our behalf, spends a rate-limit bucket, and writes both a
   * status and an audit row.
   *
   * **A failed check answers 200.** "Your record is not there yet" is the
   * expected state for most of the minutes after a seller publishes it, and a
   * screen that has to catch an exception to render a normal outcome is a
   * screen that renders it badly.
   */
  app.post('/domains/:id/verify', requireCapability('domains:manage'), async (c) => {
    const parsed = verifyBody.safeParse(await readJson(c));

    if (!parsed.success) {
      throw new InvalidRequestError('Send a JSON body naming the verification method.');
    }

    return c.json(
      await domains.verify({
        /* From a `memberships` row, never from the body (P0-48). */
        tenantId: c.get('tenantId'),
        domainId: c.req.param('id'),
        method: parsed.data.method,
      }),
    );
  });

  /**
   * Add a domain.
   *
   * Behind `domains:manage`, which only an OWNER holds: a verified origin is
   * what lets a widget key work anywhere at all, so adding one is closer to
   * billing than to editing a product.
   *
   * The body carries the raw string the seller typed. It is normalised in the
   * port (P2-05) rather than validated into a shape here, because there is
   * exactly one authority on what an origin is and a second opinion in a route
   * handler is how `https://winery.com.` and `HTTPS://WINERY.COM` become two
   * different rows.
   */
  app.post('/domains', requireCapability('domains:manage'), async (c) => {
    const parsed = domainBody.safeParse(await readJson(c));

    if (!parsed.success) {
      throw new InvalidRequestError('Send a JSON body carrying the domain to add.');
    }

    return c.json(
      await domains.add({
        /* From a `memberships` row, never from the body (P0-48). */
        tenantId: c.get('tenantId'),
        input: parsed.data.domain,
      }),
      201,
    );
  });

  /**
   * Change a member's role.
   *
   * `PATCH` rather than `PUT`: the body carries the role and nothing else, and
   * a `PUT` would imply the caller is replacing the whole membership — which
   * would invite somebody to send `tenantId` in it, which is exactly the thing
   * P0-48 exists to make impossible.
   */
  app.patch('/members/:userId', requireCapability('members:manage'), async (c) => {
    const parsed = roleChangeBody.safeParse(await readJson(c));

    if (!parsed.success) {
      throw new InvalidRequestError('Send a JSON body carrying a role of OWNER or EDITOR.');
    }

    const userId = c.req.param('userId');

    const outcome = await members.changeRole({
      tenantId: c.get('tenantId'),
      userId,
      role: parsed.data.role,
    });

    /*
     * Throws on anything but success, and the mapping lives in
     * `packages/core` so this handler and the one below cannot disagree about
     * it: a member of another winery is 404 and never 403 (§3.5), and the
     * last-OWNER refusal is a 409 whose message says how to proceed.
     */
    assertMemberWriteSucceeded(outcome);

    return c.json({ userId, role: parsed.data.role });
  });

  /**
   * Remove a member.
   *
   * The same guard as a demotion, one clause shorter — a winery cannot be left
   * with no owner either way (P0-52). The audit row matters most here, because
   * the `memberships` row is gone afterwards and nothing else records that the
   * person was ever a member.
   */
  app.delete('/members/:userId', requireCapability('members:manage'), async (c) => {
    const userId = c.req.param('userId');

    assertMemberWriteSucceeded(await members.remove({ tenantId: c.get('tenantId'), userId }));

    return c.json({ userId, removed: true as const });
  });

  /**
   * Withdraw an invitation.
   *
   * 404 when nothing matched — already accepted, already revoked, or never
   * existed. One answer for all three, because distinguishing them tells a
   * caller which invitation ids are real, and none of the distinctions helps
   * an owner who is trying to make a link stop working.
   */
  app.delete('/members/invitations/:id', requireCapability('members:manage'), async (c) => {
    const invitationId = c.req.param('id');

    const revoked = await members.revoke({ tenantId: c.get('tenantId'), invitationId });
    if (!revoked) throw new NotFoundError('No such invitation.');

    return c.json({ invitationId, revoked: true as const });
  });

  return app;
};

/**
 * Every dashboard route, keyed by `METHOD <mounted path>`.
 *
 * **Separate from the registrations above, deliberately.** Metadata attached
 * inline disappears with the route it decorated; a table can be enumerated,
 * diffed and cross-checked — which is what P0-49's boot check does, what
 * P0-50's role x endpoint matrix walks, and what P0-62 generates the OpenAPI
 * document from. Adding a route without adding a line here is a **startup
 * failure**, not a silent default to open.
 *
 * The paths carry the mount prefix because that is how Hono reports them from
 * `app.routes`; deriving both from the same constant is what stops the two
 * drifting when the surface moves.
 *
 * `summary`, `description` and `example` exist for P0-62 and are required
 * rather than optional: a reference where half the routes are blank is
 * decorative, so the generator refuses one exactly as the boot check refuses an
 * undeclared route.
 */
export interface RouteDoc {
  readonly access: RouteAccess;
  /** One line. What a caller gets. */
  readonly summary: string;
  /** Why a caller would use it, and anything surprising about the answer. */
  readonly description: string;
  /** A representative success body. Concrete values, never `"string"`. */
  readonly example: unknown;
  /**
   * The success response, as a schema (P0-63).
   *
   * Required, and this is what makes a generated client worth having: the types
   * both consumers compile against come from here, so a breaking change to a
   * response fails typecheck in the widget and the dashboard at build time
   * rather than surfacing as a runtime error in a seller's storefront.
   *
   * An example alone cannot do that. It says what one answer looked like, not
   * what any answer must look like.
   */
  readonly response: z.ZodType;
  /**
   * The error statuses this route answers with, when they are not its
   * surface's usual set (review fix).
   *
   * Absent, the reference lists the surface's defaults; present, exactly these.
   * A route that refuses nothing, like a surface marker, says so rather than
   * inheriting a 401 or a 429 it never sends — a documented refusal sends a
   * reader looking for a guard that is not there.
   */
  readonly refusals?: readonly number[];
}

export const DASHBOARD_ROUTES: ReadonlyMap<string, RouteDoc> = new Map<string, RouteDoc>([
  [
    routeKey('GET', DASHBOARD_PREFIX),
    {
      access: publicRoute(
        'Surface marker. Reports which app answered and nothing else - no tenant, ' +
          'no user, no data. P0-46 uses it to prove the two surfaces are distinct.',
      ),
      summary: 'Identify the dashboard surface',
      description:
        'Returns the name of the route surface that handled the request. It exists so a ' +
        'caller - or a test - can prove *which* application answered, rather than only ' +
        'that something did. Carries no tenant, user or catalogue data.',
      example: { surface: 'dashboard' },
      response: surfaceResponse,
      // Refuses nothing: no session to lack and no capability to check (review fix).
      refusals: [],
    },
  ],
  [
    routeKey('GET', `${DASHBOARD_PREFIX}/me`),
    {
      access: publicRoute(
        'Authenticated but pre-tenant, by necessity: a user with several memberships ' +
          'cannot choose from a list they are not allowed to fetch. It returns only the ' +
          "caller's own identity and memberships, which RLS scopes to them (P0-47).",
      ),
      summary: 'The caller and the wineries they belong to',
      description:
        'Authenticated, but resolved before a tenant is chosen - a user who belongs to ' +
        'several wineries cannot pick one from a list they are not allowed to fetch. The ' +
        'memberships returned are scoped by Row Level Security to the caller, so this ' +
        'cannot be used to enumerate anybody else. Send the chosen tenant back on ' +
        'subsequent requests in the active-tenant header.',
      example: {
        userId: 'user_matteo',
        memberships: [
          { tenantId: '9f2c1b7e-4a30-4c1a-9f2e-1b7e4a304c1a', role: 'OWNER' },
          { tenantId: 'c3d5a881-6b12-4f77-9a10-6b124f779a10', role: 'EDITOR' },
        ],
      },
      response: meResponse,
    },
  ],
  [
    routeKey('GET', `${DASHBOARD_PREFIX}/context`),
    {
      access: requires('catalog:read'),
      summary: 'The resolved tenant and role for this request',
      description:
        'Reports what the server decided the request is scoped to. The tenant comes from ' +
        'a `memberships` row for the authenticated user and never from request input; the ' +
        'role comes from that same row, so a user who is EDITOR on one winery and OWNER ' +
        'on another gets the right one for the winery in play.',
      example: { tenantId: '9f2c1b7e-4a30-4c1a-9f2e-1b7e4a304c1a', role: 'EDITOR' },
      response: contextResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/members/invite`),
    {
      access: requires('members:manage'),
      summary: 'Invite somebody to this winery',
      description:
        'Creates a single-use invitation and emails it. The role is chosen here, by a ' +
        'caller who holds members:manage - it is never read from the acceptance request, ' +
        'where the sender would be the person who benefits from it. Re-inviting an ' +
        'address that is already a member, or already has an open invitation, answers 200 ' +
        'with `created: false` rather than an error: the intent is already satisfied, and ' +
        'sending again on every click would mail somebody repeatedly through our domain.',
      example: { email: 'anna@cantinarossi.example', created: true },
      response: inviteResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/members/accept`),
    {
      access: publicRoute(
        'Authenticated but pre-tenant, by necessity: the caller is not yet a member of ' +
          'the winery they are joining - becoming one is what the request does - so ' +
          'tenant resolution would refuse them before the handler ran. The tenant comes ' +
          'from the invitation row, matched by a 256-bit token and set inside the same ' +
          'transaction, so it still comes out of Postgres rather than off the wire.',
      ),
      summary: 'Redeem an invitation',
      description:
        'Exchanges an invitation token for a membership, and returns the membership as ' +
        'written so the dashboard can switch straight into the new winery. The role comes ' +
        'from the invitation the owner created; a role sent in the body is a 400, not a ' +
        'silently ignored field. Every unusable token - unknown, expired, revoked, already ' +
        'redeemed, addressed to somebody else - answers 404 alike, so this cannot be used ' +
        'to discover which invitations exist.',
      example: { tenantId: '9f2c1b7e-4a30-4c1a-9f2e-1b7e4a304c1a', role: 'EDITOR' },
      response: acceptInviteResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/products`),
    {
      access: requires('catalog:write'),
      summary: 'Add a wine to the catalogue',
      description:
        'Creates a product and queues it for embedding in the same transaction, so a ' +
        'wine that exists is always a wine that will become findable — there is no ' +
        'state where one committed and the other did not. The tenant comes from a ' +
        'memberships row and never from the body, which the contract makes ' +
        'unrepresentable rather than merely discouraged. A SKU already used in this ' +
        'winery answers 409 and names it; the uniqueness is scoped to the winery the ' +
        'caller belongs to, so the answer discloses nothing about any other catalogue. ' +
        'The response ' +
        'is the row as stored, including the defaults the server filled in, so the ' +
        'client need not re-fetch to learn them.',
      example: {
        id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        sku: 'BAR-2019',
        externalVariantId: '43215678901234',
        name: 'Barolo Bussia',
        producer: 'Poderi Colla',
        vintage: 2019,
        wineType: 'red',
        grapeVarieties: ['Nebbiolo'],
        region: 'Piemonte',
        denomination: 'Barolo DOCG',
        styleTags: ['strutturato', 'tannico'],
        tastingNotes: 'Rosa appassita, catrame e ciliegia sotto spirito.',
        foodPairings: ['brasato al Barolo', 'formaggi stagionati'],
        alcoholPct: '14.50',
        priceCents: 4500,
        currency: 'EUR',
        stockStatus: 'IN_STOCK',
        stockQty: 24,
        productUrl: 'https://cantina.example/barolo-bussia',
        imageUrl: 'https://cantina.example/img/barolo-bussia.jpg',
        status: 'ACTIVE',
        embeddingState: 'PENDING',
        embeddingFailure: null,
        createdAt: '2026-09-08T09:14:00.000Z',
        updatedAt: '2026-09-08T09:14:00.000Z',
      },
      response: productCreatedResponse,
    },
  ],
  [
    routeKey('PATCH', `${DASHBOARD_PREFIX}/products/:id`),
    {
      access: requires('catalog:write'),
      summary: 'Edit a wine',
      description:
        'Applies a partial update. Re-embedding is queued only when the change touches ' +
        'something the model actually reads — a price or stock correction costs nothing, ' +
        'which is what keeps the embedding bill tracking the catalogue rather than how ' +
        'often it is edited. An edit that does re-embed leaves the row STALE: still ' +
        'findable under its previous description while the new one is built, as opposed ' +
        'to PENDING, which means never indexed at all. A product belonging to another ' +
        'winery answers 404 and never 403, so this cannot be used to discover which ' +
        'product ids exist elsewhere.',
      example: {
        id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        sku: 'BAR-2019',
        externalVariantId: '43215678901234',
        name: 'Barolo Bussia',
        producer: 'Poderi Colla',
        vintage: 2019,
        wineType: 'red',
        grapeVarieties: ['Nebbiolo'],
        region: 'Piemonte',
        denomination: 'Barolo DOCG',
        styleTags: ['strutturato', 'tannico'],
        tastingNotes: 'Rosa appassita, catrame e ciliegia sotto spirito.',
        foodPairings: ['brasato al Barolo', 'formaggi stagionati'],
        alcoholPct: '14.50',
        priceCents: 4900,
        currency: 'EUR',
        stockStatus: 'IN_STOCK',
        stockQty: 18,
        productUrl: 'https://cantina.example/barolo-bussia',
        imageUrl: 'https://cantina.example/img/barolo-bussia.jpg',
        status: 'ACTIVE',
        embeddingState: 'INDEXED',
        embeddingFailure: null,
        createdAt: '2026-09-08T09:14:00.000Z',
        updatedAt: '2026-09-08T11:02:00.000Z',
      },
      response: productUpdatedResponse,
    },
  ],
  [
    routeKey('DELETE', `${DASHBOARD_PREFIX}/products/:id`),
    {
      access: requires('catalog:write'),
      summary: 'Remove a wine from the catalogue',
      description:
        'Archives the product and deletes its vectors in one transaction. Two different ' +
        'kinds of delete, deliberately: the row survives because an order placed last ' +
        'month refers to it, and a catalogue that forgets what it sold cannot answer a ' +
        'customer about their own purchase — while the vectors go outright, because a ' +
        'vector is not history but the thing retrieval searches, so leaving one means the ' +
        'wine keeps being recommended after it was removed. Archiving twice is not an ' +
        'error: the intent is already satisfied. A product belonging to another winery ' +
        'answers 404, never 403.',
      example: {
        id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        status: 'ARCHIVED',
        noLongerRecommended: true,
        vectorsRemoved: 1,
      },
      response: productArchivedResponse,
    },
  ],
  [
    routeKey('GET', `${DASHBOARD_PREFIX}/products`),
    {
      access: requires('catalog:read'),
      summary: 'One page of the catalogue',
      description:
        'Keyset pagination: pass the `nextCursor` from the previous page rather than an ' +
        'offset. That is a correctness choice before a performance one — an offset page ' +
        'two repeats a row when something was inserted while somebody was paging, which ' +
        'on an import screen is exactly when the data is changing. The cursor is opaque ' +
        'and must not be parsed; it encodes the sort position and is free to change. ' +
        'Sortable fields are an allowlist, and an unknown one is refused rather than ' +
        'quietly ignored. `limit` is clamped to 100. Archived wines are hidden unless ' +
        '`includeArchived=true`. Passing `q` searches instead of listing: results come back ' +
        'by relevance rather than by the sort, because a search ordered by creation date is ' +
        'a filter wearing a search box. When nothing matches the text, the search falls back ' +
        'to trigram similarity over the name and producer — and says so in `matchedBy`, ' +
        'because a fallback presented as an exact match leads a seller to conclude their ' +
        'catalogue contains something it does not. Filters — stockStatus, wineType, grape, ' +
        'embeddingState and a price range in minor units — compose into the same query as ' +
        'the sort and the search, so they narrow a search exactly as they narrow a list. ' +
        '`grape` is the one that is not a convenience: free-text search cannot find by ' +
        'grape, because the array could not be folded into the searchable column, so it is ' +
        'the only way to ask "find me a nebbiolo". A ' +
        'price range whose bounds are the wrong way round returns nothing rather than an ' +
        'error: that is a slider dragged past itself, not a malformed request.',
      example: {
        items: [
          {
            id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
            sku: 'BAR-2019',
            externalVariantId: '43215678901234',
            name: 'Barolo Bussia',
            producer: 'Poderi Colla',
            vintage: 2019,
            wineType: 'red',
            grapeVarieties: ['Nebbiolo'],
            region: 'Piemonte',
            denomination: 'Barolo DOCG',
            styleTags: ['strutturato'],
            tastingNotes: 'Rosa appassita, catrame e ciliegia sotto spirito.',
            foodPairings: ['brasato al Barolo'],
            alcoholPct: '14.50',
            priceCents: 4500,
            currency: 'EUR',
            stockStatus: 'IN_STOCK',
            stockQty: 24,
            productUrl: 'https://cantina.example/barolo-bussia',
            imageUrl: 'https://cantina.example/img/barolo-bussia.jpg',
            status: 'ACTIVE',
            embeddingState: 'INDEXED',
            embeddingFailure: null,
            createdAt: '2026-09-08T09:14:00.000Z',
            updatedAt: '2026-09-08T09:14:00.000Z',
          },
        ],
        nextCursor: 'Y29sdW1u.MjAyNi0wOS0wOFQwOToxNDowMC4wMDBa.N2M5ZTY2Nzk',
        matchedBy: null,
      },
      response: productListResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/products/reindex-all`),
    {
      access: requires('catalog:write'),
      summary: 'Re-queue the whole catalogue for embedding',
      description:
        'Queues an embedding job for every active wine and returns a batch id recorded ' +
        'on each one. Archived wines are left alone, because re-embedding one would put ' +
        'it back in front of visitors, which is what archiving means to stop. This is ' +
        'cheaper than it sounds: a wine whose vector already matches its text costs no ' +
        'provider call, so the job runs, finds nothing to do and reconciles the row. What ' +
        'it repairs is every way a row and its vector can disagree - a failed wine gets ' +
        'another attempt, a wine whose queue entry was lost gets a new one. A second run ' +
        'while the first is still draining answers 409 and says how many are left: two ' +
        'batches index nothing twice, they only make the wait longer. The batch id is not ' +
        'a handle to poll - read each wine embeddingState instead.',
      example: { batchId: '0f7c1b7e-4a30-4c1a-9f2e-1b7e4a304c1a', queued: 1284 },
      response: catalogueReindexedResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/rag/simulate`),
    {
      access: requires('catalog:read'),
      summary: 'Run retrieval for a question and show its working',
      description:
        'Runs the real retrieval pipeline for a question - the same embedding, the same ' +
        'hybrid search, the same availability and price filter, the same candidate cap that ' +
        'a visitor gets - and returns the ranking with the numbers that produced it. This ' +
        'is the endpoint for "the widget recommends the wrong wine": reproducing that ' +
        'through the live widget inflates usage counters, fills analytics with ' +
        'conversations nobody had, and still shows only the answer rather than the ' +
        'reasoning. Each candidate reports where each branch ranked it, the fused score, ' +
        'how completely it is described, and whether it reached the prompt - with ' +
        'excludedBy saying why not, which is usually the answer: the right wine was found ' +
        'at rank eleven and cut by the cap, or it is out of stock. preCapCount separates ' +
        '"nothing matched" from "matched, but weakly". No usage, no analytics and no ' +
        'conversation is recorded, so it can be run as often as it takes. Retrieval only: ' +
        'no model is asked to write a reply, and the instructions that would be sent are ' +
        'identified by hash rather than returned.',
      example: {
        candidates: [
          {
            productId: '3f1c0b7e-4a30-4c1a-9f2e-1b7e4a304c1a',
            name: 'Barolo Monfortino Riserva',
            vectorRank: 2,
            vectorScore: 0.81,
            lexicalRank: 1,
            rrfScore: 0.0325,
            completeness: { score: 78, missing: ['annata'], topSuggestion: 'annata' },
            stockStatus: 'IN_STOCK',
            priceCents: 18_500,
            included: true,
            excludedBy: null,
          },
        ],
        preCapCount: 23,
        zeroResultKind: null,
        timings: { embedMs: 142.6, searchMs: 38.2 },
        systemPromptHash: '9f2e1b7e4a304c1a',
      },
      response: ragSimulationResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/products/import`),
    {
      access: requires('catalog:write'),
      summary: 'Import wines in bulk, matched by SKU',
      description:
        'Creates the wines whose SKU is new to this catalogue, updates the ones that ' +
        'changed and leaves the rest untouched, queuing an embedding only where the text ' +
        'the model reads moved. Nothing is ever archived or cleared: a field a row does ' +
        'not carry keeps its value. Rows are applied in batches of 200, each in its own ' +
        'transaction, so an import that stops part-way answers with how far it got, and ' +
        "stoppedAt.reason says why: 'failed' when a batch failed, or 'time-budget' when the " +
        'request ran out of time before the next batch. An import too large for one request ' +
        'stops between batches after about six seconds, rather than being cut off by the ' +
        'ten-second timeout. Either way, send the rows from fromRow on, less those refused ' +
        'as duplicate SKUs, under a new Idempotency-Key to continue; a row already applied ' +
        'comes back unchanged if it is sent again. ' +
        'A row that does not match the product contract refuses the whole request before ' +
        'anything is written, and rows sharing a SKU are all refused. A body over 5 MB is ' +
        'refused before it is parsed. The body names where the rows came from - form, paste ' +
        'or file, with the file name - for the single audit entry written by an import that ' +
        'reached the catalogue. Every import carries an ' +
        'Idempotency-Key header holding a UUID per attempt: a repeat with the same key and the ' +
        'same rows answers with the body the first attempt returned and runs nothing, even when ' +
        'that attempt stopped part-way. The same key with different rows, or while the first ' +
        'attempt is still running, answers 409.',
      example: {
        outcomes: [
          { index: 0, outcome: 'created', productId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
        ],
        counts: { created: 1, updated: 0, unchanged: 0, duplicateSku: 0, archived: 0 },
        stoppedAt: null,
      },
      response: productsImportedResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/products/import/preview`),
    {
      access: requires('catalog:write'),
      summary: 'Preview what an import would do, writing nothing',
      description:
        'Classifies each row exactly as the import would - created, updated, unchanged, or ' +
        'refused for sharing a SKU with another row - so a screen can show what confirming ' +
        'will change before anything does. Nothing is written, locked, queued or audited, and ' +
        'no Idempotency-Key is needed. The import body limits apply: at most 2,500 rows and ' +
        '5 MB, every row valid against the product contract. A preview is not a promise: a ' +
        'wine edited between the preview and the import can change its outcome, which is why ' +
        'the import answers with its own.',
      example: {
        outcomes: [
          { index: 0, outcome: 'created' },
          {
            index: 1,
            outcome: 'unchanged',
            productId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
            reindexed: false,
            archived: false,
          },
        ],
        counts: { created: 1, updated: 0, unchanged: 1, duplicateSku: 0, archived: 0 },
      },
      response: importPreviewResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/products/:id/reindex`),
    {
      access: requires('catalog:write'),
      summary: 'Re-queue one wine for embedding',
      description:
        'Queues an embedding job for a single wine and returns the row as it now stands, ' +
        'so a grid can show the new state without guessing the transition. An INDEXED ' +
        'wine becomes STALE - still findable under its previous description while a new ' +
        'one is built - and a FAILED one returns to PENDING with its error cleared. A ' +
        'wine whose vector is already current costs no provider call by design; what this ' +
        'repairs is a row and a vector that disagree. An archived wine answers 409 rather ' +
        'than being quietly accepted, because the worker discards its job and a 202 would ' +
        'claim something was happening. A product belonging to another winery answers ' +
        '404, never 403.',
      example: {
        product: {
          id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          sku: 'BAR-2019',
          externalVariantId: '43215678901234',
          name: 'Barolo Bussia',
          producer: 'Poderi Colla',
          vintage: 2019,
          wineType: 'red',
          grapeVarieties: ['Nebbiolo'],
          region: 'Piemonte',
          denomination: 'Barolo DOCG',
          styleTags: ['strutturato'],
          tastingNotes: 'Rosa appassita, catrame e ciliegia sotto spirito.',
          foodPairings: ['brasato al Barolo'],
          alcoholPct: '14.50',
          priceCents: 4500,
          currency: 'EUR',
          stockStatus: 'IN_STOCK',
          stockQty: 24,
          productUrl: 'https://cantina.example/barolo-bussia',
          imageUrl: 'https://cantina.example/img/barolo-bussia.jpg',
          status: 'ACTIVE',
          embeddingState: 'STALE',
          embeddingFailure: null,
          completeness: 78,
          createdAt: '2026-09-08T09:14:00.000Z',
          updatedAt: '2026-09-08T09:14:00.000Z',
        },
        queued: true,
      },
      response: productReindexedResponse,
    },
  ],
  [
    routeKey('GET', `${DASHBOARD_PREFIX}/members`),
    {
      access: requires('members:manage'),
      summary: 'Who belongs to this winery',
      description:
        'The roster: a name, address, role and join date for each member. Behind ' +
        '`members:manage` rather than a read capability, because who else can reach the ' +
        'catalogue and billing of a winery is not neutral information, and an EDITOR ' +
        'has no action to take on it. Scoped by Row Level Security to the active winery, ' +
        'so it cannot be used to enumerate anybody else.',
      example: {
        members: [
          {
            userId: 'user_matteo',
            email: 'matteo@cantina.example',
            name: 'Matteo Rossi',
            role: 'OWNER',
            joinedAt: '2026-08-01T09:14:00.000Z',
          },
        ],
      },
      response: rosterResponse,
    },
  ],
  [
    routeKey('GET', `${DASHBOARD_PREFIX}/members/invitations`),
    {
      access: requires('members:manage'),
      summary: 'Invitations still outstanding',
      description:
        'Open invitations only — accepted and revoked ones are history, and listing them ' +
        'would show a growing set of things nobody can act on. Carries no token and no ' +
        'hash, because the hash is what the credential reduces to and returning it would ' +
        'hand a caller material to attack offline, for no gain over revoking and ' +
        're-inviting.',
      example: {
        invitations: [
          {
            id: '4f1c9a2e-77b8-4a6d-9c31-2e77b84a6d9c',
            email: 'anna@cantina.example',
            role: 'EDITOR',
            invitedBy: 'user_matteo',
            expiresAt: '2026-09-14T09:14:00.000Z',
            createdAt: '2026-09-07T09:14:00.000Z',
          },
        ],
      },
      response: pendingInvitationsResponse,
    },
  ],
  [
    routeKey('PATCH', `${DASHBOARD_PREFIX}/members/:userId`),
    {
      access: requires('members:manage'),
      summary: "Change a member's role",
      description:
        'Refuses with 409 when it would leave the winery with no OWNER, and the message ' +
        'says how to proceed: promote somebody first. The guard is inside the SQL ' +
        'statement and takes a lock over the whole roster, so two simultaneous demotions ' +
        'cannot both succeed. A user who belongs to another winery answers 404, never ' +
        '403, so this cannot be used to probe which accounts exist elsewhere.',
      example: { userId: 'user_anna', role: 'EDITOR' },
      response: roleChangeResponse,
    },
  ],
  [
    routeKey('DELETE', `${DASHBOARD_PREFIX}/members/:userId`),
    {
      access: requires('members:manage'),
      summary: 'Remove a member',
      description:
        'The same last-OWNER guard as a role change. Writes an audit row inside the same ' +
        'transaction, which matters more here than anywhere else: the membership row is ' +
        'gone afterwards, so nothing else records that the person was ever a member or ' +
        'who removed them.',
      example: { userId: 'user_anna', removed: true },
      response: memberRemovedResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/domains`),
    {
      access: requires('domains:manage'),
      summary: 'Add a domain',
      description:
        'Normalises whatever the seller typed into one canonical origin (P2-05) and creates ' +
        'a PENDING row with a verification nonce. An origin another winery already holds is ' +
        'refused with 409 and a message that says only that it is not available: naming the ' +
        'other winery would make this an oracle for enumerating who our customers are. An ' +
        'origin this winery already holds is answered with the row it has, so the screen can ' +
        'show the token again rather than reporting a conflict that is not one. Every ' +
        'attempt is audited, including the refused ones, which are the interesting ones.',
      example: {
        domain: {
          id: '9f0b2d41-6c3a-4e8b-9d27-1a5c8e3f7b40',
          origin: 'https://www.winery.com',
          registrableDomain: 'winery.com',
          status: 'PENDING',
          verificationToken: null,
          createdAt: '2026-09-25T09:00:00.000Z',
        },
        created: true,
      },
      response: domainAddedResponse,
    },
  ],
  [
    routeKey('GET', `${DASHBOARD_PREFIX}/keys`),
    {
      access: requires('keys:manage'),
      summary: "Read the winery's keys",
      description:
        'The public key and a hint of the secret one — its prefix and last four characters, ' +
        'enough to answer "which key is live?" and not enough to use it. There is no field for ' +
        'the secret key and no way to ask for it: it is shown once, when issued, and never ' +
        'stored anywhere it could be read back from. 404 before any keys have been issued.',
      example: {
        publicKey: 'pk_live_…',
        secretKeyPrefix: 'sk_live_Ab3x',
        secretKeyLast4: 'Wq7Z',
        createdAt: '2026-09-26T09:00:00.000Z',
        updatedAt: '2026-09-26T09:00:00.000Z',
      },
      response: keysResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/keys`),
    {
      access: requires('keys:manage'),
      summary: "Issue the winery's first keys",
      description:
        'Generates a public key and a secret key. **The secret key is in this response and ' +
        'nowhere else, ever**: it is stored as a SHA-256 hash (ADR 0025) and cannot be shown ' +
        'again, so the only remedy for not having copied it is to rotate. Served no-store, ' +
        'because a secret a proxy or the back button could replay is a secret stored somewhere ' +
        'we cannot delete. 409 if the winery already has keys — replacing them here would ' +
        'invalidate a secret the seller may already have deployed.',
      example: {
        publicKey: 'pk_live_…',
        secretKeyPrefix: 'sk_live_Ab3x',
        secretKeyLast4: 'Wq7Z',
        createdAt: '2026-09-26T09:00:00.000Z',
        updatedAt: '2026-09-26T09:00:00.000Z',
        secretKey: 'sk_live_…shown once…',
      },
      response: issuedKeysResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/keys/secret/rotate`),
    {
      access: requires('keys:manage'),
      summary: 'Replace the secret key',
      description:
        'Effective immediately, with no grace window: a seller rotates a secret when they think ' +
        'it has leaked, and a window in which the old one still works is a window in which the ' +
        "leak still works. The public key is untouched — it is live on the seller's pages, " +
        'and rotating it is its own route with its own grace (P4-08). The new secret is in ' +
        'this response only.',
      example: {
        publicKey: 'pk_live_…',
        secretKeyPrefix: 'sk_live_Hk2p',
        secretKeyLast4: 'x9Rd',
        createdAt: '2026-09-26T09:00:00.000Z',
        updatedAt: '2026-09-26T09:30:00.000Z',
        secretKey: 'sk_live_…shown once…',
      },
      response: issuedKeysResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/keys/public/rotate`),
    {
      access: requires('keys:manage'),
      summary: 'Replace the public key',
      description:
        'Issues a new public key and keeps the old one resolving for 24 hours, because the old ' +
        "key is in a script tag on the seller's pages until they redeploy — and a window any " +
        'shorter would break a live storefront the moment the button is pressed. **At most one ' +
        "old key is ever live**: a second rotation ends the first one's grace, since a seller " +
        'rotates when they think a key has leaked and rotating again must not leave the first ' +
        'leaked key working. The secret key is carried across unchanged; rotating it is its ' +
        "own route. Serialised on the winery's row, so two simultaneous rotations cannot both " +
        'find the same active key.',
      example: {
        publicKey: 'pk_live_…new…',
        secretKeyPrefix: 'sk_live_Ab3x',
        secretKeyLast4: 'Wq7Z',
        createdAt: '2026-09-26T10:00:00.000Z',
        updatedAt: '2026-09-26T10:00:00.000Z',
        previous: { publicKey: 'pk_live_…old…', validUntil: '2026-09-27T10:00:00.000Z' },
      },
      response: keysResponse,
    },
  ],
  [
    routeKey('DELETE', `${DASHBOARD_PREFIX}/domains/:id`),
    {
      access: requires('domains:manage'),
      summary: 'Remove a domain',
      description:
        'Deletes the row and, in the same transaction, writes a per-origin session cutoff that ' +
        'ends every live session on it — we never store the `jti`s we issue, so revoking them ' +
        'one by one is impossible by construction and a timestamp does it in one row. The ' +
        'effect is immediate today because the allowlist is uncached, and the cutoff is what ' +
        'keeps it immediate once §5.7 caches it. A real delete, not a tombstone: the unique ' +
        'index on origin is the anti-sharing backbone, and a kept row would hold that origin ' +
        'against every winery for ever. Removing the last **verified** domain needs ' +
        '`?confirm=true`, because it switches the widget off everywhere it is installed. ' +
        "Another winery's id answers 404, never 403.",
      example: {
        origin: 'https://www.winery.com',
        removed: true,
        sessionsEnded: true,
        verifiedRemaining: 1,
      },
      response: domainRemovedResponse,
    },
  ],
  [
    routeKey('POST', `${DASHBOARD_PREFIX}/domains/:id/verify`),
    {
      access: requires('domains:manage'),
      summary: "Check a domain's proof",
      description:
        'Takes one of two proofs, whichever the seller can actually produce: a `_somm-verify` ' +
        'TXT record, or a file at `/.well-known/somm-verify-<nonce>.txt` — the nonce is in the ' +
        'path, so the URL is itself unguessable. The file check goes through `guardedFetch` ' +
        '(P4-03a), which validates the address at socket connect, refuses redirects, and allows ' +
        'only https on 443; what it declined to do is recorded and never returned, because a ' +
        'caller who could read it could map our network with it. ' +
        'A verification also creates the other spelling — apex gains its `www` and the reverse ' +
        '— because the proof was of the zone and `www` is inside it, and a `www` mismatch is ' +
        'otherwise the most common support ticket there is. Both are listed and both are ' +
        'individually removable: the allowlist never widens invisibly. Each is probed with a ' +
        'HEAD request through the same guarded agent, and a host that does not answer is ' +
        'flagged rather than deleted. ' +
        'The DNS check resolves the TXT record and compares it, in constant ' +
        'time, against the nonce we issued. **The resolver is a pinned public one rather than ' +
        "the host's**: in a VPC the default resolver answers for internal names and can be " +
        'reconfigured by anybody with that reach, so a verification that trusted it could be ' +
        'forged for any domain and the forged answer would look real. A record that is absent, ' +
        'wrong, or unreachable answers 200 with `verified: false` and prose saying which — they ' +
        'send a seller to three different places. Attempts are counted per domain, because this ' +
        "route makes a network call on demand. Another winery's id answers 404, never 403.",
      example: {
        domain: {
          id: '9f0b2d41-6c3a-4e8b-9d27-1a5c8e3f7b40',
          origin: 'https://www.winery.com',
          registrableDomain: 'winery.com',
          status: 'VERIFIED',
          verificationToken: null,
          verificationExpiresAt: null,
          createdAt: '2026-09-25T09:00:00.000Z',
        },
        verified: true,
      },
      response: domainVerifiedResponse,
    },
  ],
  [
    routeKey('DELETE', `${DASHBOARD_PREFIX}/members/invitations/:id`),
    {
      access: requires('members:manage'),
      summary: 'Withdraw an invitation',
      description:
        'Stamps the invitation revoked rather than deleting it, so the fact that one was ' +
        'sent and withdrawn survives for an incident review — and so a fresh invitation ' +
        'to the same address succeeds, which the partial unique index allows only once ' +
        'the old row is closed. Answers 404 for an id that is already accepted, already ' +
        'revoked, or never existed: one answer, so this cannot be used to discover which ' +
        'invitation ids are real.',
      example: { invitationId: '4f1c9a2e-77b8-4a6d-9c31-2e77b84a6d9c', revoked: true },
      response: invitationRevokedResponse,
    },
  ],
]);

/**
 * The access half of the table, for the callers that only need that.
 *
 * Derived rather than maintained separately - two tables that must agree are
 * two tables that will not.
 */
export const DASHBOARD_ROUTE_ACCESS: ReadonlyMap<string, RouteAccess> = new Map(
  [...DASHBOARD_ROUTES].map(([key, doc]) => [key, doc.access]),
);

/**
 * A route's response as JSON Schema, for the OpenAPI document (P0-62, P0-63).
 *
 * Converted here rather than in `scripts/gen-openapi.mjs` because this is where
 * `zod` is a declared dependency — a script reaching for it through pnpm's
 * isolated `node_modules` would resolve by luck.
 */
export const responseJsonSchema = (doc: RouteDoc): unknown =>
  z.toJSONSchema(doc.response, { io: 'output' });
