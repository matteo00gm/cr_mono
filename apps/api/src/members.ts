import {
  audit,
  hashInvitationToken,
  invitationIsFor,
  prepareInvite,
  setRequestTenant,
  type Role,
  type SendEmail,
} from '@catalogorosso/core';
import {
  emailIsMember,
  isSuppressed,
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

/**
 * Why nothing was created, when nothing was.
 *
 * Three reasons rather than a boolean, because they are three different things
 * to tell an owner — and because the caller uses the distinction to decide
 * whether to send mail at all. Re-sending on every click would make an invite
 * button a way to mail somebody repeatedly through our sending domain, which is
 * the behaviour that gets a domain onto a filter list (P0-64).
 *
 * The HTTP response still reports a boolean today; the members screen (E8) is
 * what will have somewhere useful to put the reason.
 */
export type InviteOutcome = 'invited' | 'already-member' | 'already-invited' | 'undeliverable';

export interface InviteResult {
  readonly outcome: InviteOutcome;
  readonly created: boolean;
}

/** What the invite transaction hands back: a refusal, or what the mail needs. */
type Opened =
  | { readonly outcome: Exclude<InviteOutcome, 'invited'> }
  | {
      readonly outcome: 'invited';
      readonly tenantName: string;
      readonly inviterEmail: string;
    };

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
  /**
   * The audit writer (P0-53), injected.
   *
   * A port rather than a direct import for two reasons, and the second is why
   * it is worth the parameter. `audit()` reads the actor from an
   * `AsyncLocalStorage` in `packages/core`, and a test that mocks
   * `@catalogorosso/db` gets a *second* instance of that module for this file's
   * import graph — so the context the test sets is invisible here, and the call
   * throws for a reason that has nothing to do with the code.
   *
   * More usefully: injecting it is what makes the audit row **assertable**.
   * Before this it was written and nothing checked that it was.
   */
  readonly audit?: typeof audit;
}

export const createMembersPort = ({
  sendEmail,
  acceptUrlBase,
  audit: record = audit,
}: MembersDeps): MembersPort => ({
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
    const opened = await withTenant(command.tenantId, async (tx): Promise<Opened> => {
      if (await emailIsMember(tx, prepared.email)) return { outcome: 'already-member' };

      /*
       * Checked here rather than left to `sendEmail`'s own guard, and the
       * difference is not an optimisation. The mail is sent *after* this
       * transaction commits, so a suppressed address would otherwise leave a
       * live invitation that can never be delivered — an owner told "invited"
       * and an invitee who never hears anything. The transaction is already
       * open and the table needs no scope, so asking now costs one query.
       */
      if (await isSuppressed(tx, prepared.email)) return { outcome: 'undeliverable' };

      const id = await insertInvitation(tx, {
        email: prepared.email,
        role: prepared.role,
        tokenHash: prepared.tokenHash,
        invitedBy: command.invitedBy,
        expiresAt: prepared.expiresAt,
      });

      if (id === undefined) return { outcome: 'already-invited' };

      /*
       * Recorded inside the same transaction as the row it describes (P0-53).
       * An audit entry for an invitation that rolled back is worse than none,
       * because it is a record people will believe — and this is the action an
       * owner asks about later: who invited this person, and when.
       *
       * The address is in `target` rather than `metadata`, so it is the thing
       * the row is *about* rather than free-form detail that the redaction
       * allowlist would strip.
       */
      await record(tx, {
        action: 'member.invited',
        target: prepared.email,
        metadata: { role: prepared.role, invitationId: id },
      });

      /*
       * The winery's name and the inviter's address are read here rather than
       * passed in, because the handler has no database and threading them
       * through the request would mean trusting values the caller supplied for
       * the contents of mail we send in their name.
       */
      return {
        outcome: 'invited',
        tenantName: (await readActiveTenantName(tx)) ?? 'AI Sommelier',
        inviterEmail: (await readUserEmail(tx, command.invitedBy)) ?? 'noreply',
      };
    });

    if (opened.outcome !== 'invited') return { outcome: opened.outcome, created: false };

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

    return { outcome: 'invited', created: true };
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

        /*
         * The tenant is put into the request context *here*, and this is the
         * one route where that does not come from `resolveTenant`.
         *
         * It cannot: this endpoint sits above that middleware because the
         * caller is not yet a member (P0-51). The tenant is nonetheless
         * resolved — by a 256-bit token matched against a row — so setting it
         * is not a shortcut around P0-48 but the same guarantee reached another
         * way. `audit()` needs it, and every log line for the rest of the
         * request carries it as a side benefit.
         */
        setRequestTenant(invitation.tenantId);

        await record(tx, {
          action: 'member.joined',
          target: command.userId,
          metadata: { role: invitation.role, invitationId: invitation.id },
        });

        return { tenantId: invitation.tenantId, role: invitation.role as Role };
      },
    );

    return outcome;
  },
});
