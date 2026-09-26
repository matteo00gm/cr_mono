import type { TwoFactorChange, TwoFactorEvent } from '@catalogorosso/core';

/**
 * Every change to somebody's second factor, in the audit log (P4-11).
 *
 * **One row per winery the user belongs to.** A second factor belongs to the
 * user, not to a membership, so turning it off weakens every winery they can act
 * for — and the owner of each should be able to see that in their own log. A
 * row written to one winery chosen at random would be missing from the others,
 * which is the log an incident review would be reading.
 *
 * **After the change, not with it.** Better Auth commits the change on its own
 * connection, so the audit row cannot share its transaction the way `audit()`
 * requires elsewhere (P0-53). The order is the safe one — the change happened,
 * then it is recorded — and a failed write is logged rather than thrown: the
 * user's action has already succeeded, and turning its response into an error
 * would invite a retry of something already done.
 */

export const TWO_FACTOR_AUDIT_ACTIONS: Readonly<Record<TwoFactorEvent, string>> = {
  enabled: 'mfa.enabled',
  replaced: 'mfa.replaced',
  backup_codes_regenerated: 'mfa.backup_codes_regenerated',
  disabled: 'mfa.disabled',
};

export interface TwoFactorAuditRow {
  readonly actorUserId: string;
  readonly action: string;
  readonly target: string;
}

export interface TwoFactorAuditDeps {
  /** The wineries the user belongs to — `readMembershipsForUser`, under `withUser`. */
  readonly memberships: (userId: string) => Promise<readonly { readonly tenantId: string }[]>;
  /** Writes one row, in that winery's own tenant scope. */
  readonly record: (tenantId: string, row: TwoFactorAuditRow) => Promise<void>;
  readonly onFailure: (error: unknown, change: TwoFactorChange) => void;
}

export const recordTwoFactorChange =
  ({ memberships, record, onFailure }: TwoFactorAuditDeps) =>
  async (change: TwoFactorChange): Promise<void> => {
    try {
      for (const { tenantId } of await memberships(change.userId)) {
        await record(tenantId, {
          actorUserId: change.userId,
          action: TWO_FACTOR_AUDIT_ACTIONS[change.event],
          target: `user:${change.userId}`,
        });
      }
    } catch (error) {
      onFailure(error, change);
    }
  };
