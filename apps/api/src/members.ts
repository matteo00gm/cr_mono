import {
  hashInvitationToken,
  invitationIsFor,
  prepareInvite,
  type Role,
  type SendEmail,
} from '@catalogorosso/core';
import {
  emailIsMember,
  insertInvitation,
  insertMembershipFromInvitation,
  markInvitationAccepted,
  readActiveTenantName,
  readUserEmail,
  withInvitation,
  withTenant,
} from '@catalogorosso/db';

/**
 * The invitation port and its database-backed implementation (P0-51).
 *
 * This is the composition root's job rather than a package's: it is the one
 * place that knows both how invitations are stored and how mail is sent, and
 * neither package should learn about the other. `packages/db` has no email and
 * `packages/core` has no database — the two meet here.
 */

export interface InviteCommand {
  readonly tenantId: string;
  readonly email: string;
  readonly role: Role;
  /** The inviting user's id, from the session. */
  readonly invitedBy: string;
}

export interface InviteResult {
  /**
   * False when nothing was created — the address is already a member, or an
   * invitation to it is already open.
   *
   * Reported rather than swallowed, because the caller uses it to decide
   * whether to send mail. Re-sending on every click would make an invite button
   * a way to mail somebody repeatedly through our sending domain, which is
   * exactly the behaviour that gets a domain onto a filter list (P0-64).
   */
  readonly created: boolean;
}

export interface AcceptCommand {
  readonly token: string;
  readonly userId: string;
}

export interface MembersPort {
  invite(command: InviteCommand): Promise<InviteResult>;
  /** `undefined` for every unusable token, with no distinction between them. */
  accept(command: AcceptCommand): Promise<{ tenantId: string; role: Role } | undefined>;
}

/**
 * The port with nothing behind it.
 *
 * `createApp` uses this when no implementation is supplied. It throws rather
 * than returning a plausible answer, which is the difference that matters: an
 * unconfigured invite endpoint must fail loudly and completely, never appear to
 * work. Contrast `auth`, which is a required option precisely because its
 * absent form would be *permissive* — here the absent form refuses everything.
 */
export class MembersPortNotConfiguredError extends Error {
  constructor() {
    super(
      'No members port was supplied to createApp, so invitations cannot be created or ' +
        'accepted. This is a wiring bug at the composition root, not a request problem.',
    );
    this.name = 'MembersPortNotConfiguredError';
  }
}

export const unconfiguredMembers: MembersPort = {
  invite: () => Promise.reject(new MembersPortNotConfiguredError()),
  accept: () => Promise.reject(new MembersPortNotConfiguredError()),
};

/* -------------------------------------------------------------------------- */

export interface MembersDeps {
  readonly sendEmail: SendEmail;
  /** Where the invitee lands. The token is appended as the last path segment. */
  readonly acceptUrlBase: string;
}

export const createMembersPort = ({ sendEmail, acceptUrlBase }: MembersDeps): MembersPort => ({
  async invite(command) {
    const prepared = prepareInvite(
      { email: command.email, role: command.role },
      { now: new Date() },
    );

    /*
     * The whole invite is one transaction, and the email is sent *after* it
     * commits. The ordering is deliberate and it is the lesser of two evils: a
     * committed invitation with no mail is recoverable — the owner re-sends —
     * while mail carrying a token for a row that rolled back is a link that
     * fails for a customer with no explanation and no way to tell whether they
     * are the problem.
     */
    const opened = await withTenant(command.tenantId, async (tx) => {
      if (await emailIsMember(tx, prepared.email)) return undefined;

      const id = await insertInvitation(tx, {
        email: prepared.email,
        role: prepared.role,
        tokenHash: prepared.tokenHash,
        invitedBy: command.invitedBy,
        expiresAt: prepared.expiresAt,
      });

      if (id === undefined) return undefined;

      /*
       * The winery's name and the inviter's address are read here rather than
       * passed in, because the handler has no database and threading them
       * through the request would mean trusting values the caller supplied for
       * the contents of mail we send in their name.
       */
      return {
        tenantName: (await readActiveTenantName(tx)) ?? 'AI Sommelier',
        inviterEmail: (await readUserEmail(tx, command.invitedBy)) ?? 'noreply',
      };
    });

    if (opened === undefined) return { created: false };

    await sendEmail({
      to: prepared.email,
      template: 'invite',
      props: {
        tenantName: opened.tenantName,
        inviterEmail: opened.inviterEmail,
        // The token, not its hash. The hash is what the database holds; the
        // plaintext exists only here and in the message.
        acceptUrl: `${acceptUrlBase}/${prepared.token}`,
        expiresInDays: Math.round(
          (prepared.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
        ),
      },
    });

    return { created: true };
  },

  async accept(command) {
    const outcome = await withInvitation(
      hashInvitationToken(command.token),
      async (tx, invitation) => {
        const email = await readUserEmail(tx, command.userId);

        // No session email means the account was deleted between sign-in and
        // now. Indistinguishable from a bad token, on purpose.
        if (email === undefined || !invitationIsFor(invitation, { email })) return undefined;

        await insertMembershipFromInvitation(tx, {
          tenantId: invitation.tenantId,
          userId: command.userId,
          // From the invitation row. Never from the request — that is the
          // escalation this endpoint would otherwise be.
          role: invitation.role,
          invitedBy: invitation.invitedBy,
        });

        await markInvitationAccepted(tx, invitation.id);

        return { tenantId: invitation.tenantId, role: invitation.role as Role };
      },
    );

    return outcome;
  },
});
