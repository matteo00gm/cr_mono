import type { MembershipReader } from '@catalogorosso/core';

import type { AuthPort } from '../../src/middleware/auth.js';

/**
 * A stand-in for Better Auth (P0-45).
 *
 * The reason `apps/api` depends on a two-member port rather than the library's
 * own type. Constructing a real `Auth` builds a drizzle adapter, which opens a
 * connection at construction — so without this, asserting that a guard rejects
 * an anonymous request would need a container and a `DATABASE_URL`.
 *
 * What the real thing does behind `getSession` — cookie parsing, signature
 * checks, the cookie cache, expiry — is Better Auth's, and it is tested against
 * a real database and a real cookie in P0-46. What is tested *here* is our own
 * wiring: that the guard is mounted in the right place, on the right surface,
 * and that it attaches the user and nothing else.
 */

export interface FakeAuth extends AuthPort {
  /** Requests that reached Better Auth's handler, in order. */
  readonly handled: string[];
  /** How many times a session was read. */
  readonly sessionReads: () => number;
}

export interface FakeAuthOptions {
  /**
   * Who the session resolves to. `null` — the default — is signed out, which
   * is the state most assertions care about.
   */
  readonly user?: { id: string; email: string } | null;
}

export const fakeAuth = (options: FakeAuthOptions = {}): FakeAuth => {
  const handled: string[] = [];
  let reads = 0;
  const user = options.user ?? null;

  return {
    handled,
    sessionReads: () => reads,

    handler: (request: Request) => {
      handled.push(new URL(request.url).pathname);
      // Echoes the path so a test can prove *which* handler answered, rather
      // than only that something did.
      return Promise.resolve(
        Response.json({ betterAuth: new URL(request.url).pathname }, { status: 200 }),
      );
    },

    api: {
      getSession: () => {
        reads += 1;
        return Promise.resolve(user === null ? null : { user });
      },
    },
  };
};

/** A signed-in session, for the routes that need one. */
export const signedIn = (id = 'user_matteo'): FakeAuth =>
  fakeAuth({ user: { id, email: 'matteo@example.com' } });

/**
 * A membership reader backed by a plain array (P0-47).
 *
 * The middleware's job is to decide *which* membership applies and to refuse
 * when none does; where the rows came from is the database's job, and the
 * integration suite proves RLS returns the right ones. Splitting the two keeps
 * the decision testable in milliseconds.
 */
export const memberships =
  (rows: readonly { tenantId: string; role: 'OWNER' | 'EDITOR' }[] = []): MembershipReader =>
  () =>
    Promise.resolve(rows);

/** The common case: one winery, no choice to make. */
export const oneMembership = (
  tenantId = '11111111-1111-1111-1111-111111111111',
  role: 'OWNER' | 'EDITOR' = 'OWNER',
): MembershipReader => memberships([{ tenantId, role }]);
