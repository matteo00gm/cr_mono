import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { MembersPort } from '../src/members.js';
import { memberships, oneMembership, signedIn } from './support/auth.js';

/**
 * The members screen's five routes (E8).
 *
 * These close the gap P0-51 and P0-52 left: the roster writes, the last-OWNER
 * guard, the invitations table and its `revoked_at` column all existed and
 * nothing called any of them. An owner could invite and do nothing else.
 *
 * What is asserted here is the *surface* — who may call each route, what a
 * refusal looks like, and that the outcome mapping is the one §3.5 requires.
 * The behaviour underneath belongs to real Postgres and is asserted there:
 * `last-owner.integration.test.ts` for the concurrency, and
 * `invitations.integration.test.ts` for revocation and the partial index.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

const port = (overrides: Partial<MembersPort>): MembersPort => ({
  invite: () => Promise.reject(new Error('not stubbed')),
  accept: () => Promise.reject(new Error('not stubbed')),
  roster: () => Promise.reject(new Error('not stubbed')),
  pending: () => Promise.reject(new Error('not stubbed')),
  changeRole: () => Promise.reject(new Error('not stubbed')),
  remove: () => Promise.reject(new Error('not stubbed')),
  revoke: () => Promise.reject(new Error('not stubbed')),
  ...overrides,
});

const app = (role: 'OWNER' | 'EDITOR', members: Partial<MembersPort>) =>
  createApp({
    auth: signedIn(),
    readMemberships: oneMembership(TENANT, role),
    members: port(members),
  });

const send = (built: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) =>
  built.request(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

describe('GET /members', () => {
  it('returns the roster for an OWNER', async () => {
    const built = app('OWNER', {
      roster: () =>
        Promise.resolve([
          {
            userId: 'user_matteo',
            email: 'matteo@cantina.example',
            name: 'Matteo',
            role: 'OWNER',
            joinedAt: new Date('2026-08-01T09:14:00.000Z'),
          },
        ]),
    });

    const response = await send(built, 'GET', '/v1/dashboard/members');
    const body = (await response.json()) as { members: { email: string }[] };

    expect(response.status).toBe(200);
    expect(body.members[0]?.email).toBe('matteo@cantina.example');
  });

  it('refuses an EDITOR', async () => {
    /*
     * Behind `members:manage` rather than a read capability. Who else can reach
     * a winery's catalogue and billing is not neutral information, and an
     * EDITOR has no action to take on it — so the narrower capability would be
     * a decision to make when a screen needs it, not a default to fall into.
     */
    const built = app('EDITOR', { roster: () => Promise.resolve([]) });

    expect((await send(built, 'GET', '/v1/dashboard/members')).status).toBe(403);
  });

  it('refuses a caller with no membership at all', async () => {
    const built = createApp({
      auth: signedIn(),
      readMemberships: memberships([]),
      members: port({ roster: () => Promise.resolve([]) }),
    });

    expect((await send(built, 'GET', '/v1/dashboard/members')).status).toBe(403);
  });
});

describe('GET /members/invitations', () => {
  it('lists what is outstanding', async () => {
    const built = app('OWNER', {
      pending: () =>
        Promise.resolve([
          {
            id: 'inv_1',
            email: 'anna@cantina.example',
            role: 'EDITOR',
            invitedBy: 'user_matteo',
            expiresAt: new Date('2026-09-14T00:00:00.000Z'),
            createdAt: new Date('2026-09-07T00:00:00.000Z'),
          },
        ]),
    });

    const response = await send(built, 'GET', '/v1/dashboard/members/invitations');
    const body = (await response.json()) as { invitations: Record<string, unknown>[] };

    expect(response.status).toBe(200);

    /*
     * No token and no hash on the wire. The hash is what the credential reduces
     * to, and handing it to anyone with `members:manage` gives them material to
     * attack offline for no gain over revoking and re-inviting.
     */
    expect(JSON.stringify(body)).not.toContain('token');
    expect(JSON.stringify(body)).not.toContain('hash');
  });

  it('refuses an EDITOR', async () => {
    const built = app('EDITOR', { pending: () => Promise.resolve([]) });

    expect((await send(built, 'GET', '/v1/dashboard/members/invitations')).status).toBe(403);
  });
});

describe('PATCH /members/:userId', () => {
  it('changes a role', async () => {
    const built = app('OWNER', { changeRole: () => Promise.resolve('changed') });

    const response = await send(built, 'PATCH', '/v1/dashboard/members/user_anna', {
      role: 'EDITOR',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'user_anna', role: 'EDITOR' });
  });

  it('answers 409 when it would leave no owner, and says how to proceed', async () => {
    const built = app('OWNER', { changeRole: () => Promise.resolve('would-remove-last-owner') });

    const response = await send(built, 'PATCH', '/v1/dashboard/members/user_matteo', {
      role: 'EDITOR',
    });
    const body = (await response.json()) as { error?: { message?: string } };

    expect(response.status).toBe(409);

    /*
     * The message is the API contract and reaches the caller verbatim (P0-55),
     * so the content is asserted rather than only the status. An owner who has
     * just been refused needs the next step, not a diagnosis.
     */
    expect(body.error?.message).toContain('Promote another member to OWNER first');
  });

  it('answers 404 for a member of another winery', async () => {
    const built = app('OWNER', { changeRole: () => Promise.resolve('no-such-member') });

    // Not 403 (§3.5). A 403 for a real user and a 404 for an invented one would
    // let an owner of one winery probe which accounts belong to another.
    const response = await send(built, 'PATCH', '/v1/dashboard/members/user_elsewhere', {
      role: 'EDITOR',
    });

    expect(response.status).toBe(404);
  });

  it('rejects a body carrying anything but a role', async () => {
    let seen: unknown;
    const built = app('OWNER', {
      changeRole: (command) => {
        seen = command;
        return Promise.resolve('changed');
      },
    });

    /*
     * `.strict()`, so a `tenantId` in the body is rejected rather than silently
     * dropped — an attempt should look like a rejection to the operator, not
     * like success to the attacker.
     *
     * 422 rather than 400, which is this repository's mapping for
     * `InvalidRequestError`: the request was well-formed JSON and its *content*
     * was unacceptable, which is the distinction the two codes exist to draw.
     */
    const response = await send(built, 'PATCH', '/v1/dashboard/members/user_anna', {
      role: 'EDITOR',
      tenantId: '22222222-2222-2222-2222-222222222222',
    });

    expect(response.status).toBe(422);
    expect(seen).toBeUndefined();
  });

  it('rejects an unknown role', async () => {
    const built = app('OWNER', { changeRole: () => Promise.resolve('changed') });

    expect(
      (await send(built, 'PATCH', '/v1/dashboard/members/user_anna', { role: 'ADMIN' })).status,
    ).toBe(422);
  });

  it('refuses an EDITOR', async () => {
    const built = app('EDITOR', { changeRole: () => Promise.resolve('changed') });

    expect(
      (await send(built, 'PATCH', '/v1/dashboard/members/user_anna', { role: 'OWNER' })).status,
    ).toBe(403);
  });

  it('takes the target from the path and the tenant from the session', async () => {
    let seen: { tenantId: string; userId: string } | undefined;
    const built = app('OWNER', {
      changeRole: (command) => {
        seen = command;
        return Promise.resolve('changed');
      },
    });

    await send(built, 'PATCH', '/v1/dashboard/members/user_anna', { role: 'EDITOR' });

    // P0-48: the tenant is resolved from a memberships row, never from input.
    expect(seen).toMatchObject({ tenantId: TENANT, userId: 'user_anna' });
  });
});

describe('DELETE /members/:userId', () => {
  it('removes a member', async () => {
    const built = app('OWNER', { remove: () => Promise.resolve('changed') });

    const response = await send(built, 'DELETE', '/v1/dashboard/members/user_anna');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'user_anna', removed: true });
  });

  it('answers 409 for the last owner', async () => {
    const built = app('OWNER', { remove: () => Promise.resolve('would-remove-last-owner') });

    expect((await send(built, 'DELETE', '/v1/dashboard/members/user_matteo')).status).toBe(409);
  });

  it('answers 404 for a member of another winery', async () => {
    const built = app('OWNER', { remove: () => Promise.resolve('no-such-member') });

    expect((await send(built, 'DELETE', '/v1/dashboard/members/user_elsewhere')).status).toBe(404);
  });

  it('refuses an EDITOR', async () => {
    const built = app('EDITOR', { remove: () => Promise.resolve('changed') });

    expect((await send(built, 'DELETE', '/v1/dashboard/members/user_anna')).status).toBe(403);
  });
});

describe('DELETE /members/invitations/:id', () => {
  it('withdraws an invitation', async () => {
    const built = app('OWNER', { revoke: () => Promise.resolve(true) });

    const response = await send(built, 'DELETE', '/v1/dashboard/members/invitations/inv_1');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invitationId: 'inv_1', revoked: true });
  });

  it('answers 404 for anything that cannot be withdrawn', async () => {
    /*
     * Already accepted, already revoked, or never existed — one answer for all
     * three. Distinguishing them tells a caller which invitation ids are real,
     * and none of the distinctions helps an owner trying to make a link stop
     * working.
     */
    const built = app('OWNER', { revoke: () => Promise.resolve(false) });

    expect((await send(built, 'DELETE', '/v1/dashboard/members/invitations/inv_gone')).status).toBe(
      404,
    );
  });

  it('refuses an EDITOR', async () => {
    const built = app('EDITOR', { revoke: () => Promise.resolve(true) });

    expect((await send(built, 'DELETE', '/v1/dashboard/members/invitations/inv_1')).status).toBe(
      403,
    );
  });
});
