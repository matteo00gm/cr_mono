import type { MembershipReader } from '@catalogorosso/core';
import { publicRoute, requires, ROLES, type RouteAccess } from '@catalogorosso/security';
import {
  acceptInviteResponse,
  contextResponse,
  invitationRevokedResponse,
  inviteResponse,
  meResponse,
  memberRemovedResponse,
  pendingInvitationsResponse,
  productArchivedResponse,
  productCreatedResponse,
  productListResponse,
  productUpdatedResponse,
  roleChangeResponse,
  rosterResponse,
  surfaceResponse,
} from '@catalogorosso/api-client';
import { Hono } from 'hono';
import { z } from 'zod';

import {
  assertMemberWriteSucceeded,
  ConflictError,
  InvalidRequestError,
  NotFoundError,
} from '@catalogorosso/core';
import { isSortField, MAX_LIMIT, productInsert, productUpdate } from '@catalogorosso/db';

import type { AppEnv } from '../env.js';
import { mountAuthRoutes, requireUser, type AuthPort } from '../middleware/auth.js';
import { requireCapability, routeKey } from '../middleware/capability.js';
import { resolveTenant } from '../middleware/tenant.js';
import { unconfiguredMembers, type MembersPort } from '../members.js';
import { toProductResponse, unconfiguredProducts, type ProductsPort } from '../products.js';
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
  limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
  sort: z.string().refine(isSortField, 'not a sortable field').optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().min(1).max(512).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export const createDashboardApp = ({
  auth,
  readMemberships,
  members = unconfiguredMembers,
  products = unconfiguredProducts,
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

    const result = await products.create({
      /*
       * From a `memberships` row, never from the body (P0-48). The contract
       * makes the alternative impossible rather than merely discouraged.
       */
      tenantId: c.get('tenantId'),
      values: parsed.data,
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
          `priceCents, direction asc or desc, and limit a whole number up to ${String(MAX_LIMIT)}.`,
      );
    }

    const page = await products.list({ tenantId: c.get('tenantId'), ...parsed.data });

    return c.json({
      items: page.items.map(toProductResponse),
      nextCursor: page.nextCursor,
    });
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
        '`includeArchived=true`.',
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
            createdAt: '2026-09-08T09:14:00.000Z',
            updatedAt: '2026-09-08T09:14:00.000Z',
          },
        ],
        nextCursor: 'MjAyNi0wOS0wOFQwOToxNDowMC4wMDBa.N2M5ZTY2Nzk',
      },
      response: productListResponse,
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
