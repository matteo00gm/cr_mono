import { describe, expect, it } from 'vitest';

import { DomainError } from '../src/errors.js';
import {
  ACTIVE_TENANT_HEADER,
  resolveMembership,
  type Membership,
  type MembershipReader,
} from '../src/members.js';

/**
 * Membership resolution (P0-47).
 *
 * The decision, isolated from where the rows came from. What the database
 * returns is RLS's problem and is asserted against a real container in
 * `apps/api/test/tenant.integration.test.ts`; what is decided *given* those
 * rows is here, where it runs in milliseconds and every branch is reachable.
 */

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

const reader =
  (...rows: Membership[]): MembershipReader =>
  () =>
    Promise.resolve(rows);

const kindOf = async (promise: Promise<unknown>): Promise<string> => {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  return error instanceof DomainError ? error.kind : 'no error';
};

describe('one membership', () => {
  it('resolves without the caller saying anything', async () => {
    // The overwhelmingly common case: one winery, no choice to make.
    const membership = await resolveMembership({
      userId: 'user_1',
      read: reader({ tenantId: A, role: 'EDITOR' }),
    });

    expect(membership).toEqual({ tenantId: A, role: 'EDITOR' });
  });

  it('still refuses a request naming a different tenant', async () => {
    /*
     * The IDOR this whole task exists to prevent, in its simplest form: a
     * member of A asking to act as B. The answer comes from the membership
     * list, never from the request.
     */
    expect(
      await kindOf(
        resolveMembership({
          userId: 'user_1',
          requestedTenantId: B,
          read: reader({ tenantId: A, role: 'OWNER' }),
        }),
      ),
    ).toBe('not_found');
  });
});

describe('several memberships', () => {
  const both = reader({ tenantId: A, role: 'EDITOR' }, { tenantId: B, role: 'OWNER' });

  it('honours a selection that matches one of them', async () => {
    const membership = await resolveMembership({
      userId: 'user_1',
      requestedTenantId: B,
      read: both,
    });

    expect(membership).toEqual({ tenantId: B, role: 'OWNER' });
  });

  it('carries the role from the selected row, not from the user', async () => {
    /*
     * The subtle half of this task, and a distinct bug from trusting a client
     * tenant id. This user is EDITOR on A and OWNER on B — entirely
     * legitimate. An implementation that resolved the tenant correctly but
     * carried a role cached per *user* would grant them OWNER on A.
     */
    const onA = await resolveMembership({ userId: 'user_1', requestedTenantId: A, read: both });
    const onB = await resolveMembership({ userId: 'user_1', requestedTenantId: B, read: both });

    expect(onA.role).toBe('EDITOR');
    expect(onB.role).toBe('OWNER');
  });

  it('refuses to guess when no selection is given', async () => {
    /*
     * Not an error to paper over with a default. Picking the first would
     * silently write to a winery the user did not mean, and "first" is whatever
     * the query planner felt like that day.
     */
    expect(await kindOf(resolveMembership({ userId: 'user_1', read: both }))).toBe('invalid');
  });

  it('names the header in the message, since the caller has to act on it', async () => {
    const error: unknown = await resolveMembership({ userId: 'user_1', read: both }).catch(
      (caught: unknown) => caught,
    );

    expect((error as Error).message).toContain(ACTIVE_TENANT_HEADER);
  });
});

describe('a selection that does not match', () => {
  it('answers 404, not 403 — so tenant existence is not an oracle', async () => {
    /*
     * §3.5, and the natural implementation gets it wrong: "you asked for a
     * tenant you may not have" reads like a 403. But a 403 for a real winery
     * and a 404 for a made-up one lets anyone with an account map which tenant
     * ids exist. Both answer 404, so the response carries no information.
     */
    expect(
      await kindOf(
        resolveMembership({
          userId: 'user_1',
          requestedTenantId: '33333333-3333-3333-3333-333333333333',
          read: reader({ tenantId: A, role: 'OWNER' }),
        }),
      ),
    ).toBe('not_found');
  });

  it('treats a revoked membership exactly like a forged one', async () => {
    /*
     * The re-validation the whole selection mechanism rests on. A header held
     * over from a session where the user *was* a member takes the same path as
     * one they invented, and gets the same answer — on every request, not just
     * at sign-in.
     */
    const stale = await kindOf(
      resolveMembership({
        userId: 'user_1',
        requestedTenantId: B,
        read: reader({ tenantId: A, role: 'OWNER' }),
      }),
    );
    const forged = await kindOf(
      resolveMembership({
        userId: 'user_1',
        requestedTenantId: 'not-even-a-uuid',
        read: reader({ tenantId: A, role: 'OWNER' }),
      }),
    );

    expect(stale).toBe(forged);
  });
});

describe('no memberships at all', () => {
  it('answers 403, and the contrast with 404 is deliberate', async () => {
    /*
     * Nothing is being named here, so there is no existence to leak. The caller
     * is authenticated and simply belongs to nothing — an invited user whose
     * invitation was revoked, or an account created before any winery was set
     * up. Telling them so is honest and actionable; a 404 would send them
     * looking for a broken URL.
     */
    expect(await kindOf(resolveMembership({ userId: 'user_1', read: reader() }))).toBe('forbidden');
  });

  it('answers 403 even when a tenant was requested', async () => {
    // Consistent: with no memberships the caller cannot be told apart from
    // anyone else with none, whatever they asked for.
    expect(
      await kindOf(resolveMembership({ userId: 'user_1', requestedTenantId: A, read: reader() })),
    ).toBe('forbidden');
  });
});
