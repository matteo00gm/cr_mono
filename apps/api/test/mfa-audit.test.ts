import { describe, expect, it } from 'vitest';

import {
  recordTwoFactorChange,
  TWO_FACTOR_AUDIT_ACTIONS,
  type TwoFactorAuditRow,
} from '../src/mfa-audit.js';

/**
 * Every change to a second factor, in the audit log of every winery the user
 * belongs to (P4-11). That the rows land in `audit_log` under each tenant's own
 * scope is the composition root's wiring of `withTenant` and `insertAuditRow`;
 * what is decided here is which rows, and what a failure does.
 */

const written: { tenantId: string; row: TwoFactorAuditRow }[] = [];
const failures: unknown[] = [];

const recorder = (tenants: readonly string[], fail?: Error) =>
  recordTwoFactorChange({
    memberships: () => Promise.resolve(tenants.map((tenantId) => ({ tenantId }))),
    record: (tenantId, row) => {
      if (fail !== undefined) return Promise.reject(fail);
      written.push({ tenantId, row });
      return Promise.resolve();
    },
    onFailure: (error) => failures.push(error),
  });

describe('a change to a second factor', () => {
  it('is written to every winery the user can act for', async () => {
    /* One authenticator covers them all, so turning it off weakens them all. */
    written.length = 0;

    await recorder(['t1', 't2'])({ userId: 'u1', event: 'disabled' });

    expect(written).toEqual([
      { tenantId: 't1', row: { actorUserId: 'u1', action: 'mfa.disabled', target: 'user:u1' } },
      { tenantId: 't2', row: { actorUserId: 'u1', action: 'mfa.disabled', target: 'user:u1' } },
    ]);
  });

  it('names each event as its own action', () => {
    /* `replaced` is the one an attacker would make, so it is never folded into `enabled`. */
    expect(new Set(Object.values(TWO_FACTOR_AUDIT_ACTIONS)).size).toBe(4);
    expect(TWO_FACTOR_AUDIT_ACTIONS.replaced).toBe('mfa.replaced');
  });

  it('is reported, not thrown, when the write fails — the change has already happened', async () => {
    failures.length = 0;
    const error = new Error('connection terminated');

    await expect(
      recorder(['t1'], error)({ userId: 'u1', event: 'enabled' }),
    ).resolves.toBeUndefined();
    expect(failures).toEqual([error]);
  });

  it('writes nothing for somebody who belongs to no winery yet', async () => {
    written.length = 0;

    await recorder([])({ userId: 'u1', event: 'enabled' });

    expect(written).toEqual([]);
  });
});
