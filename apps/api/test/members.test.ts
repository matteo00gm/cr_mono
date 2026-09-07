import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  MembersPortNotConfiguredError,
  unconfiguredMembers,
  type AcceptCommand,
  type InviteCommand,
  type MembersPort,
} from '../src/members.js';
import { memberships, oneMembership, signedIn } from './support/auth.js';

/**
 * The invitation endpoints (P0-51).
 *
 * The port is a fake here on purpose. What is under test is the *wiring* — who
 * is refused, where each route sits in the middleware stack, and what the
 * handler is allowed to read from a request. Whether the row is written
 * atomically and whether the token is single-use are properties of Postgres and
 * are asserted against a real one in
 * `packages/db/test/invitations.integration.test.ts`.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const TOKEN = 'a'.repeat(43);

interface Recorder {
  readonly port: MembersPort;
  readonly invites: InviteCommand[];
  readonly accepts: AcceptCommand[];
}

const recording = (
  accept: { tenantId: string; role: 'OWNER' | 'EDITOR' } | undefined = {
    tenantId: TENANT,
    role: 'EDITOR',
  },
): Recorder => {
  const invites: InviteCommand[] = [];
  const accepts: AcceptCommand[] = [];

  return {
    invites,
    accepts,
    port: {
      invite: (command) => {
        invites.push(command);
        return Promise.resolve({ outcome: 'invited' as const, created: true });
      },
      accept: (command) => {
        accepts.push(command);
        return Promise.resolve(accept);
      },
    },
  };
};

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /members/invite', () => {
  it('creates an invitation for an OWNER', async () => {
    const { port, invites } = recording();
    const app = createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, 'OWNER'),
      members: port,
    });

    const response = await post(app, '/v1/dashboard/members/invite', {
      email: 'Anna@Cantina.Example',
      role: 'EDITOR',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: 'Anna@Cantina.Example', created: true });

    /*
     * The tenant reaching the port is the resolved one, from a memberships row.
     * Asserted on the command rather than on a mock call count, because the
     * value is the whole point (§3.5).
     */
    expect(invites[0]?.tenantId).toBe(TENANT);
    expect(invites[0]?.invitedBy).toBe('user_matteo');
    expect(invites[0]?.role).toBe('EDITOR');
  });

  it('refuses an EDITOR', async () => {
    const { port, invites } = recording();
    const app = createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, 'EDITOR'),
      members: port,
    });

    const response = await post(app, '/v1/dashboard/members/invite', {
      email: 'anna@cantina.example',
      role: 'EDITOR',
    });

    // `members:manage` is OWNER-only. The guard has to run before the handler,
    // so nothing reached the port at all.
    expect(response.status).toBe(403);
    expect(invites).toHaveLength(0);
  });

  it('reports an already-invited address as a non-creation, not an error', async () => {
    const app = createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, 'OWNER'),
      members: {
        invite: () => Promise.resolve({ outcome: 'already-invited' as const, created: false }),
        accept: () => Promise.resolve(undefined),
      },
    });

    const response = await post(app, '/v1/dashboard/members/invite', {
      email: 'anna@cantina.example',
      role: 'EDITOR',
    });

    /*
     * 200 with `created: false`, not 409. The owner's intent — make sure this
     * person can get in — is already satisfied, and a dashboard that has to
     * explain a conflict that is not one is the worse experience.
     */
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: false });
  });

  it('rejects a body with no role, and one with an invented role', async () => {
    const { port } = recording();
    const app = createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, 'OWNER'),
      members: port,
    });

    for (const body of [
      { email: 'anna@cantina.example' },
      { email: 'anna@cantina.example', role: 'ADMIN' },
      { role: 'EDITOR' },
    ]) {
      const response = await post(app, '/v1/dashboard/members/invite', body);
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });

  it('rejects a malformed body without a 500', async () => {
    const { port } = recording();
    const app = createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, 'OWNER'),
      members: port,
    });

    // `c.req.json()` rejects on unparseable input; unhandled, that is a 500 for
    // what is plainly a client mistake. 422 is this repo's status for a body
    // the server understood and refused (P0-55's `invalid` kind).
    const response = await app.request('/v1/dashboard/members/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });

    expect(response.status).toBe(422);
  });
});

describe('POST /members/accept', () => {
  it('works for a caller who belongs to no winery yet', async () => {
    /*
     * **The assertion this route exists for.** The invitee is not a member of
     * anything — that is what accepting fixes — so a route sitting below
     * `resolveTenant` would 403 exactly the people it is for, while every test
     * written against an existing member kept passing.
     */
    const { port, accepts } = recording();
    const app = createApp({
      auth: signedIn('user_anna'),
      readMemberships: memberships([]),
      members: port,
    });

    const response = await post(app, '/v1/dashboard/members/accept', { token: TOKEN });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tenantId: TENANT, role: 'EDITOR' });
    expect(accepts[0]).toEqual({ token: TOKEN, userId: 'user_anna' });
  });

  it('ignores a role sent in the body by rejecting the request', async () => {
    const { port, accepts } = recording();
    const app = createApp({
      auth: signedIn('user_anna'),
      readMemberships: memberships([]),
      members: port,
    });

    const response = await post(app, '/v1/dashboard/members/accept', {
      token: TOKEN,
      role: 'OWNER',
    });

    /*
     * The escalation this endpoint would otherwise be. `.strict()` turns the
     * attempt into a rejection rather than a silently dropped field — the difference
     * between an attacker seeing a refusal and seeing what looks like success,
     * and between an operator finding it in the logs and never knowing.
     */
    expect(response.status).toBe(422);
    expect(accepts).toHaveLength(0);
  });

  it('answers 404 for every unusable token alike', async () => {
    const app = createApp({
      auth: signedIn('user_anna'),
      readMemberships: memberships([]),
      members: {
        invite: () => Promise.resolve({ outcome: 'already-invited' as const, created: false }),
        // The port returns `undefined` for unknown, expired, revoked, already
        // redeemed and addressed-to-somebody-else without distinguishing them.
        accept: () => Promise.resolve(undefined),
      },
    });

    const response = await post(app, '/v1/dashboard/members/accept', { token: TOKEN });

    expect(response.status).toBe(404);
  });

  it('still requires a session', async () => {
    const { port, accepts } = recording();
    const app = createApp({
      auth: signedIn(),
      readMemberships: memberships([]),
      members: port,
    });

    // Pre-tenant is not the same as public. The route sits above tenant
    // resolution and below the session guard, and the ordering is asserted
    // rather than assumed — a route that drifted above `requireUser` would let
    // anybody holding a leaked token join without an account.
    const anonymous = createApp({
      auth: (await import('./support/auth.js')).fakeAuth(),
      readMemberships: memberships([]),
      members: port,
    });

    expect((await post(anonymous, '/v1/dashboard/members/accept', { token: TOKEN })).status).toBe(
      401,
    );
    expect(accepts).toHaveLength(0);
    expect((await post(app, '/v1/dashboard/members/accept', { token: TOKEN })).status).toBe(200);
  });
});

describe('the default port', () => {
  it('refuses everything loudly', async () => {
    /*
     * `members` is optional where `auth` is required, and this is what makes
     * that defensible: the absent form refuses every call with a wiring error
     * rather than serving a plausible answer. An absent `auth` would instead
     * serve the dashboard *unauthenticated*, which is why that one has no
     * default.
     */
    await expect(
      unconfiguredMembers.invite({
        tenantId: TENANT,
        email: 'a@b.example',
        role: 'EDITOR',
        invitedBy: 'user_matteo',
      }),
    ).rejects.toThrow(MembersPortNotConfiguredError);

    await expect(unconfiguredMembers.accept({ token: TOKEN, userId: 'user_anna' })).rejects.toThrow(
      MembersPortNotConfiguredError,
    );
  });
});
