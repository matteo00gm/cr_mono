import { describe, expect, it, vi } from 'vitest';

/**
 * The database-backed members port (P0-51).
 *
 * `@catalogorosso/db` is mocked, which is the one place in this suite that
 * happens and needs a reason. What is under test here is *composition* — the
 * order the steps run in, which value is carried from where, and what happens
 * when a step declines — and every one of those is a decision made in
 * `src/members.ts` rather than by Postgres. The behaviours that belong to the
 * database (the token being single-use, the policy admitting the acceptance
 * read) are asserted against a real one in
 * `packages/db/test/invitations.integration.test.ts`.
 */

const calls: string[] = [];
const state = {
  isMember: false,
  suppressed: false,
  writeOutcome: 'changed' as 'changed' | 'no-such-member' | 'would-remove-last-owner',
  revokedEmail: 'anna@cantina.example' as string | undefined,
  insertedId: undefined as string | undefined,
  invitation: undefined as
    | {
        id: string;
        tenantId: string;
        email: string;
        role: string;
        invitedBy: string;
        expiresAt: Date;
      }
    | undefined,
  userEmail: 'anna@cantina.example' as string | undefined,
  membership: undefined as Record<string, unknown> | undefined,
};

vi.mock('@catalogorosso/db', () => ({
  withTenant: (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    calls.push(`withTenant(${tenantId})`);
    return fn({});
  },
  withInvitation: (
    tokenHash: string,
    fn: (tx: unknown, invitation: NonNullable<typeof state.invitation>) => Promise<unknown>,
  ) => {
    calls.push(`withInvitation(${tokenHash.slice(0, 8)})`);
    return state.invitation === undefined ? Promise.resolve(undefined) : fn({}, state.invitation);
  },
  emailIsMember: () => {
    calls.push('emailIsMember');
    return Promise.resolve(state.isMember);
  },
  isSuppressed: () => {
    calls.push('isSuppressed');
    return Promise.resolve(state.suppressed);
  },
  insertInvitation: (_tx: unknown, row: { email: string }) => {
    calls.push(`insertInvitation(${row.email})`);
    return Promise.resolve(state.insertedId);
  },
  insertMembershipFromInvitation: (_tx: unknown, row: Record<string, unknown>) => {
    calls.push('insertMembershipFromInvitation');
    state.membership = row;
    return Promise.resolve();
  },
  markInvitationAccepted: () => {
    calls.push('markInvitationAccepted');
    return Promise.resolve();
  },
  readRoster: () => Promise.resolve([{ userId: 'user_a', role: 'OWNER' }]),
  readOpenInvitations: () => Promise.resolve([{ id: 'inv_1', email: 'anna@cantina.example' }]),
  setMemberRole: () => {
    calls.push('setMemberRole');
    return Promise.resolve(state.writeOutcome);
  },
  removeMember: () => {
    calls.push('removeMember');
    return Promise.resolve(state.writeOutcome);
  },
  revokeInvitation: () => {
    calls.push('revokeInvitation');
    return Promise.resolve(state.revokedEmail);
  },
  readActiveTenantName: () => Promise.resolve('Cantina Rossi'),
  readUserEmail: () => Promise.resolve(state.userEmail),
}));

const { createMembersPort } = await import('../src/members.js');
const { hashInvitationToken } = await import('@catalogorosso/core');

/**
 * The audit rows both paths write (P0-53).
 *
 * The writer is injected rather than reached for, which is what makes it
 * assertable — and what avoids a harness trap: `audit()` reads the actor from
 * an `AsyncLocalStorage` in `packages/core`, and mocking `@catalogorosso/db`
 * above gives `members.ts` a second instance of that module, so a context set
 * here would be invisible there.
 */
const audited: { action: string; target?: string | undefined }[] = [];

const TENANT = '11111111-1111-1111-1111-111111111111';

const build = () => {
  const sent: { to: string; props: Record<string, unknown> }[] = [];

  const port = createMembersPort({
    audit: (_tx, entry) => {
      audited.push({ action: entry.action, target: entry.target });
      return Promise.resolve();
    },
    /*
     * Typed through the port's own parameter rather than as the real
     * `SendEmail`, whose generic signature would need a template name to
     * instantiate. What this double has to be is callable and observable.
     */
    sendEmail: (options: { to: string; props: Record<string, unknown> }) => {
      calls.push('sendEmail');
      sent.push(options);
      return Promise.resolve({ status: 'sent' as const, id: 'msg_1', attempts: 1 });
    },
    acceptUrlBase: 'https://app.example/invite',
  });

  return { port, sent };
};

const reset = () => {
  calls.length = 0;
  audited.length = 0;
  state.isMember = false;
  state.suppressed = false;
  state.writeOutcome = 'changed';
  state.revokedEmail = 'anna@cantina.example';
  state.insertedId = 'inv_1';
  state.userEmail = 'anna@cantina.example';
  state.membership = undefined;
  state.invitation = {
    id: 'inv_1',
    tenantId: TENANT,
    email: 'anna@cantina.example',
    role: 'EDITOR',
    invitedBy: 'user_matteo',
    expiresAt: new Date(Date.now() + 86_400_000),
  };
};

describe('invite', () => {
  it('writes the row, then sends the mail', async () => {
    reset();
    const { port, sent } = build();

    const result = await port.invite({
      tenantId: TENANT,
      email: 'Anna@Cantina.Example',
      role: 'EDITOR',
      invitedBy: 'user_matteo',
    });

    expect(result).toEqual({ outcome: 'invited', created: true });

    /*
     * The ordering is the decision, and it is the lesser of two evils. A
     * committed invitation with no mail is recoverable — the owner re-sends —
     * while mail carrying a token for a row that rolled back is a link that
     * fails for a customer with no explanation.
     */
    expect(calls.indexOf('sendEmail')).toBeGreaterThan(
      calls.indexOf('insertInvitation(anna@cantina.example)'),
    );

    // Normalised on the way in, so the mail and the row agree with the
    // uniqueness index about what address this is.
    expect(sent[0]?.to).toBe('anna@cantina.example');
    expect(sent[0]?.props.tenantName).toBe('Cantina Rossi');
    expect(String(sent[0]?.props.acceptUrl)).toMatch(/^https:\/\/app\.example\/invite\/[\w-]+$/);
  });

  it('sends nothing when the address is already a member', async () => {
    reset();
    state.isMember = true;
    const { port, sent } = build();

    expect(
      await port.invite({
        tenantId: TENANT,
        email: 'matteo@cantina.example',
        role: 'EDITOR',
        invitedBy: 'user_matteo',
      }),
    ).toMatchObject({ created: false, outcome: 'already-member' });

    expect(sent).toHaveLength(0);
    expect(calls).not.toContain('insertInvitation(matteo@cantina.example)');
  });

  it('sends nothing when an invitation is already open', async () => {
    reset();
    // `insertInvitation` returns undefined when `ON CONFLICT DO NOTHING` fired.
    state.insertedId = undefined;
    const { port, sent } = build();

    expect(
      await port.invite({
        tenantId: TENANT,
        email: 'anna@cantina.example',
        role: 'EDITOR',
        invitedBy: 'user_matteo',
      }),
    ).toMatchObject({ created: false, outcome: 'already-invited' });

    /*
     * The re-invite no-op, and the reason it matters beyond tidiness: mailing
     * again on every click makes an invite button a way to send somebody
     * repeated messages through our sending domain, which is what puts a domain
     * on a filter list (P0-64).
     */
    expect(sent).toHaveLength(0);
  });

  it('records an audit row inside the same transaction as the invitation', async () => {
    reset();
    const { port } = build();

    await port.invite({
      tenantId: TENANT,
      email: 'anna@cantina.example',
      role: 'EDITOR',
      invitedBy: 'user_matteo',
    });

    /*
     * P0-53: the row commits or rolls back with the action it describes, which
     * is why `audit` takes the caller's transaction. "Who invited this person,
     * and when" is the question an owner asks later, and nothing else records it.
     */
    expect(audited).toEqual([{ action: 'member.invited', target: 'anna@cantina.example' }]);
    expect(calls.indexOf('sendEmail')).toBeGreaterThan(
      calls.indexOf('insertInvitation(anna@cantina.example)'),
    );
  });

  it('creates no invitation for a suppressed address', async () => {
    reset();
    state.suppressed = true;
    const { port, sent } = build();

    const result = await port.invite({
      tenantId: TENANT,
      email: 'dead@example.invalid',
      role: 'EDITOR',
      invitedBy: 'user_matteo',
    });

    /*
     * Checked *before* the insert, not left to `sendEmail`'s own guard. The
     * mail goes out after the transaction commits, so a suppressed address
     * would otherwise leave a live invitation that can never be delivered — an
     * owner told "invited" and an invitee who never hears anything.
     */
    expect(result).toMatchObject({ created: false, outcome: 'undeliverable' });
    expect(calls).not.toContain('insertInvitation(dead@example.invalid)');
    expect(audited).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('never puts the stored hash in the email', async () => {
    reset();
    const { port, sent } = build();

    await port.invite({
      tenantId: TENANT,
      email: 'anna@cantina.example',
      role: 'EDITOR',
      invitedBy: 'user_matteo',
    });

    // The link carries the token; the database holds its hash. A mail carrying
    // the hash would be a link that never works — and one carrying both would
    // make hashing pointless.
    const token = String(sent[0]?.props.acceptUrl).split('/').pop() ?? '';
    expect(token).not.toBe('');
    expect(String(sent[0]?.props.acceptUrl)).not.toContain(hashInvitationToken(token));
  });
});

describe('accept', () => {
  it('writes the membership with the role from the invitation', async () => {
    reset();
    const { port } = build();

    const result = await port.accept({ token: 'a'.repeat(43), userId: 'user_anna' });

    expect(result).toEqual({ tenantId: TENANT, role: 'EDITOR' });
    // From the row, not from the request. There is no path here that reads a
    // role off anything the invitee sent.
    expect(state.membership).toMatchObject({
      tenantId: TENANT,
      userId: 'user_anna',
      role: 'EDITOR',
      invitedBy: 'user_matteo',
    });
    expect(calls).toContain('markInvitationAccepted');

    // Recorded inside `withInvitation`'s transaction, beside the membership it
    // describes. The tenant comes from the invitation row rather than from
    // `resolveTenant`, which this route sits above by necessity.
    expect(audited).toEqual([{ action: 'member.joined', target: 'user_anna' }]);
  });

  it('looks the invitation up by hash, never by the token itself', async () => {
    reset();
    const { port } = build();
    const token = 'b'.repeat(43);

    await port.accept({ token, userId: 'user_anna' });

    expect(calls).toContain(`withInvitation(${hashInvitationToken(token).slice(0, 8)})`);
  });

  it('refuses an invitation addressed to somebody else', async () => {
    reset();
    state.userEmail = 'mallory@evil.example';
    const { port } = build();

    expect(await port.accept({ token: 'a'.repeat(43), userId: 'user_mallory' })).toBeUndefined();
    // Nothing written. A forwarded link must not admit whoever opened it.
    expect(state.membership).toBeUndefined();
    expect(calls).not.toContain('markInvitationAccepted');
  });

  it('refuses when the accepting account no longer exists', async () => {
    reset();
    state.userEmail = undefined;
    const { port } = build();

    // A session for an account deleted between sign-in and now — treated as a
    // bad token, indistinguishably.
    expect(await port.accept({ token: 'a'.repeat(43), userId: 'user_ghost' })).toBeUndefined();
    expect(state.membership).toBeUndefined();
  });

  it('reports an unusable token as undefined', async () => {
    reset();
    state.invitation = undefined;
    const { port } = build();

    expect(await port.accept({ token: 'a'.repeat(43), userId: 'user_anna' })).toBeUndefined();
  });
});

describe('the members screen (E8)', () => {
  it('reads the roster and the open invitations inside a tenant transaction', async () => {
    reset();
    const { port } = build();

    expect(await port.roster(TENANT)).toHaveLength(1);
    expect(await port.pending(TENANT)).toHaveLength(1);

    // Under RLS, so neither query names a tenant — `withTenant` is what scopes
    // them, and a predicate here would be a second source of truth for
    // something the policy already decides.
    expect(calls.filter((c) => c.startsWith('withTenant('))).toHaveLength(2);
  });

  it('records an audit row when a role actually changes', async () => {
    reset();
    const { port } = build();

    expect(await port.changeRole({ tenantId: TENANT, userId: 'user_a', role: 'EDITOR' })).toBe(
      'changed',
    );
    expect(audited).toEqual([{ action: 'member.role_changed', target: 'user_a' }]);
  });

  it('records nothing when the change was refused', async () => {
    reset();
    state.writeOutcome = 'would-remove-last-owner';
    const { port } = build();

    const outcome = await port.changeRole({ tenantId: TENANT, userId: 'user_a', role: 'EDITOR' });

    /*
     * The rule the whole audit design rests on (P0-53): an entry for something
     * that did not happen is worse than no entry, because it is a record people
     * believe. The guard lives in the SQL statement, so the port learns of a
     * refusal only from the outcome — which is exactly what this branches on.
     */
    expect(outcome).toBe('would-remove-last-owner');
    expect(audited).toEqual([]);
  });

  it('records a removal, which is the one nothing else records', async () => {
    reset();
    const { port } = build();

    expect(await port.remove({ tenantId: TENANT, userId: 'user_a' })).toBe('changed');

    // The memberships row is gone afterwards, so without this there is no
    // record anywhere that the person was ever a member.
    expect(audited).toEqual([{ action: 'member.removed', target: 'user_a' }]);
  });

  it('records nothing when a removal was refused', async () => {
    reset();
    state.writeOutcome = 'no-such-member';
    const { port } = build();

    expect(await port.remove({ tenantId: TENANT, userId: 'user_elsewhere' })).toBe(
      'no-such-member',
    );
    expect(audited).toEqual([]);
  });

  it('names the un-invited address in the audit row', async () => {
    reset();
    const { port } = build();

    expect(await port.revoke({ tenantId: TENANT, invitationId: 'inv_1' })).toBe(true);

    // The address comes back from the UPDATE rather than from a second read, so
    // there is no window in which the row could change between the two.
    expect(audited).toEqual([
      { action: 'member.invitation_revoked', target: 'anna@cantina.example' },
    ]);
  });

  it('reports a revocation that matched nothing, and records nothing', async () => {
    reset();
    state.revokedEmail = undefined;
    const { port } = build();

    // Already accepted, already revoked, or absent — the caller turns all three
    // into one 404 rather than distinguishing which ids are real.
    expect(await port.revoke({ tenantId: TENANT, invitationId: 'inv_gone' })).toBe(false);
    expect(audited).toEqual([]);
  });
});
