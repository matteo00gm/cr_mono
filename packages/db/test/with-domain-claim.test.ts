import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/client.js';
import {
  CLAIM_GUC,
  ClaimRacedError,
  NestedClaimContextError,
  settleDomainClaim,
} from '../src/with-domain-claim.js';
import { withTenant, type DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * Settling a claim, without a database (P4-18).
 *
 * The mechanics only: which statements run in which order, which tenant each
 * runs as, and which branch each kind of holder takes. **What the policy then
 * admits is asserted against real Postgres** in `with-domain-claim.integration`,
 * because a fake returns whatever it is told to.
 */

const CLAIMANT = 'a0000000-0000-4000-8000-000000000001';
const HOLDER = 'b0000000-0000-4000-8000-000000000002';
const CLAIM = 'c0000000-0000-4000-8000-000000000003';
const ORIGIN = 'https://www.winery.com';

const domainRow = (tenantStatus: 'PENDING' | 'VERIFIED' = 'VERIFIED') => ({
  id: 'd1',
  origin: ORIGIN,
  registrable_domain: 'winery.com',
  status: tenantStatus,
  verification_token: null,
  verification_expires_at: null,
  created_at: new Date('2026-09-29T09:00:00.000Z'),
});

const createMockDb = (results: unknown[][]) => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve(results.shift() ?? []);
  });

  const tx = { execute } as unknown as DbTransaction;
  const transaction = vi.fn((cb: (tx: DbTransaction) => Promise<unknown>) => cb(tx));

  return { db: { transaction } as unknown as Database, statements, transaction };
};

const params = (statement: unknown): unknown[] =>
  new PgDialect().sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]).params;

const settle = (db: Database, cap = 2) =>
  settleDomainClaim(
    {
      claimId: CLAIM,
      claimantTenantId: CLAIMANT,
      cap,
      noticeHours: 72,
      actor: { userId: 'user_anna' },
    },
    db,
  );

/** A settleable claim, a claimant under its cap that does not hold the origin. */
const opening = (
  claim: Record<string, unknown> = { status: 'PROVEN', incumbent_tenant_id: null },
  counts: Record<string, unknown> = { held: 0, covered: false },
  own: unknown[] = [],
): unknown[][] => [
  [],
  [{ origin: ORIGIN, registrable_domain: 'winery.com', settleable: true, ...claim }],
  [],
  [counts],
  own,
];

/** The claim GUC set, the holder read, the GUC cleared. */
const holderRead = (holder?: Record<string, unknown>): unknown[][] => [
  [],
  holder === undefined ? [] : [holder],
  [],
];

/** The claimant's side landing: tenant set, row inserted, claim closed, audit written. */
const landing = (inserted: unknown[] = [domainRow()]): unknown[][] => [[], inserted, [], []];

const setsTenant = (statement: unknown, tenantId: string): boolean =>
  text(statement).includes("set_config('app.tenant_id'") && params(statement).includes(tenantId);

describe('the guards', () => {
  it('refuses to open inside a tenant context, and names the tenant', async () => {
    const { db, transaction } = createMockDb([]);

    const error: unknown = await withTenant(CLAIMANT, () => settle(db), db).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(NestedClaimContextError);
    expect((error as Error).message).toContain(CLAIMANT);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('does nothing with a claim it cannot find', async () => {
    const { db, statements } = createMockDb([[], []]);

    await expect(settle(db)).resolves.toEqual({ kind: 'unsettleable' });
    expect(statements).toHaveLength(2);
  });

  it('does nothing with a claim that is not yet settleable', async () => {
    const { db, statements } = createMockDb([
      [],
      [{ origin: ORIGIN, registrable_domain: 'winery.com', status: 'NOTICE', settleable: false }],
    ]);

    await expect(settle(db)).resolves.toEqual({ kind: 'unsettleable' });
    expect(statements).toHaveLength(2);
  });

  it('reads the claim as the claimant, locked, and names the claimant as well', async () => {
    /* The holder's half of the policy would admit a claim served on it, which
     * is not one it may settle — so the statement says whose claim it wants. */
    const { db, statements } = createMockDb([[], []]);

    await settle(db);

    expect(setsTenant(statements[0], CLAIMANT)).toBe(true);
    expect(text(statements[1])).toContain('FOR UPDATE');
    expect(text(statements[1])).toContain('tenant_id =');
    expect(params(statements[1])).toEqual([CLAIM, CLAIMANT]);
  });
});

describe('the claimant’s own side', () => {
  it('closes a claim on an origin the claimant already holds, whatever its cap', async () => {
    const { db } = createMockDb([...opening(undefined, undefined, [domainRow()]), [], []]);

    await expect(settle(db, 0)).resolves.toMatchObject({
      kind: 'transferred',
      basis: 'already-held',
    });
  });

  it('refuses at the cap before it reads anybody else’s row', async () => {
    const { db, statements } = createMockDb(opening(undefined, { held: 1, covered: false }));

    await expect(settle(db, 1)).resolves.toEqual({ kind: 'at-cap', held: 1 });
    expect(statements.some((statement) => text(statement).includes(CLAIM_GUC))).toBe(false);
  });

  it('costs no slot under a registrable domain it already holds', async () => {
    const { db } = createMockDb([
      ...opening(undefined, { held: 1, covered: true }),
      ...holderRead(),
      ...landing(),
    ]);

    await expect(settle(db, 1)).resolves.toMatchObject({ kind: 'transferred', basis: 'unheld' });
  });
});

describe('the widened read', () => {
  it('sets the claim GUC for the one statement that reads the holder, and clears it next', async () => {
    const { db, statements } = createMockDb([...opening(), ...holderRead(), ...landing()]);

    await settle(db);

    const set = statements.findIndex(
      (statement) => text(statement).includes('set_config') && params(statement).includes(CLAIM),
    );

    expect(params(statements[set])).toEqual([CLAIM_GUC, CLAIM]);
    expect(text(statements[set + 1])).toContain('FROM tenant_domains WHERE origin =');
    expect(text(statements[set + 1])).toContain('FOR UPDATE');
    expect(params(statements[set + 2])).toEqual([CLAIM_GUC]);
    expect(text(statements[set + 2])).toContain("''");
  });
});

describe('an origin nobody holds', () => {
  it('lands with the claimant', async () => {
    const { db } = createMockDb([...opening(), ...holderRead(), ...landing()]);

    await expect(settle(db)).resolves.toMatchObject({ kind: 'transferred', basis: 'unheld' });
  });

  it('rolls back rather than committing half a transfer when somebody got there first', async () => {
    const { db } = createMockDb([...opening(), ...holderRead(), ...landing([])]);

    await expect(settle(db)).rejects.toBeInstanceOf(ClaimRacedError);
  });
});

describe('an origin somebody else holds', () => {
  const held = (
    status: string,
    domain: 'PENDING' | 'VERIFIED' = 'VERIFIED',
    claim?: Record<string, unknown>,
  ) =>
    createMockDb([
      ...opening(claim),
      ...holderRead({ id: 'd9', tenant_id: HOLDER, status: domain }),
      [],
      [{ status }],
      /* The holder's row deleted, its sessions cut off, its audit row written. */
      [domainRow(domain)],
      [],
      [],
      ...landing(),
    ]);

  it.each(['DISABLED', 'CANCELED', 'PENDING_VERIFICATION'])(
    'moves at once from a holder that is %s',
    async (status) => {
      const { db, statements } = held(status);

      await expect(settle(db)).resolves.toMatchObject({ kind: 'transferred', basis: 'lapsed' });
      expect(statements.some((statement) => text(statement).includes('DELETE FROM'))).toBe(true);
    },
  );

  it('moves at once from a holder that never verified it', async () => {
    const { db } = held('ACTIVE', 'PENDING');

    await expect(settle(db)).resolves.toMatchObject({ basis: 'unverified' });
  });

  it('moves once the notice served on this holder has run out', async () => {
    const { db } = held('ACTIVE', 'VERIFIED', { status: 'NOTICE', incumbent_tenant_id: HOLDER });

    await expect(settle(db)).resolves.toMatchObject({ basis: 'notice-expired' });
  });

  it.each([
    ['a paying holder', { status: 'PROVEN', incumbent_tenant_id: null }],
    ['a holder a notice was never served on', { status: 'NOTICE', incumbent_tenant_id: CLAIMANT }],
  ])('puts %s on notice and moves nothing', async (_label, claim) => {
    const { db, statements } = createMockDb([
      ...opening(claim),
      ...holderRead({ id: 'd9', tenant_id: HOLDER, status: 'VERIFIED' }),
      [],
      [{ status: 'ACTIVE' }],
      [],
      [],
      [{ transfer_at: new Date('2026-10-02T09:00:00.000Z') }],
      [],
    ]);

    await expect(settle(db)).resolves.toEqual({
      kind: 'noticed',
      transferAt: new Date('2026-10-02T09:00:00.000Z'),
    });
    expect(statements.some((statement) => text(statement).includes('DELETE FROM'))).toBe(false);
  });

  it('writes the holder’s audit row as the holder, naming nobody from the claimant’s side', async () => {
    const { db, statements } = held('DISABLED');

    await settle(db);

    const audits = statements.filter((statement) => text(statement).includes('audit_log'));
    const holderIndex = statements.indexOf(audits[0]);

    expect(params(audits[0])).toEqual([
      HOLDER,
      null,
      'domain.claimed_by_challenge',
      ORIGIN,
      JSON.stringify({ kind: 'lapsed' }),
      null,
      null,
    ]);
    expect(
      statements.slice(0, holderIndex).some((statement) => setsTenant(statement, HOLDER)),
    ).toBe(true);
    expect(params(audits[1])[0]).toBe(CLAIMANT);
    expect(params(audits[1])[1]).toBe('user_anna');
  });
});
