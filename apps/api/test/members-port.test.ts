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
