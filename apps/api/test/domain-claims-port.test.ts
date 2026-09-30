import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The claim methods of the domains port, with the driver mocked (P4-18).
 *
 * The composition only: which statements run, in which order, what is audited
 * and what a claimant is told. **The settlement itself — what the policy
 * admits, and what happens to each kind of holder — is proved against real
 * Postgres** in `packages/db`'s `with-domain-claim.integration`, and the whole
 * path end to end in `domain-claims.integration` beside this file.
 */

const calls: string[] = [];

interface ClaimRow {
  id: string;
  origin: string;
  registrableDomain: string;
  status: 'PENDING' | 'PROVEN' | 'NOTICE' | 'TRANSFERRED' | 'CANCELED';
  verificationToken: string | null;
  verificationExpiresAt: Date | null;
  transferAt: Date | null;
  createdAt: Date;
}

const claimRow = (overrides: Partial<ClaimRow> = {}): ClaimRow => ({
  id: 'c1',
  origin: 'https://www.winery.com',
  registrableDomain: 'winery.com',
  status: 'PENDING',
  verificationToken: 'the-nonce',
  verificationExpiresAt: new Date('2026-10-06T09:00:00.000Z'),
  transferAt: null,
  createdAt: new Date('2026-09-29T09:00:00.000Z'),
  ...overrides,
});

const domainRow = {
  id: 'd1',
  origin: 'https://www.winery.com',
  registrableDomain: 'winery.com',
  status: 'VERIFIED' as const,
  verificationToken: null,
  verificationExpiresAt: null,
  createdAt: new Date('2026-09-29T09:00:00.000Z'),
};

const state = {
  own: undefined as unknown,
  plan: null as string | null,
  covering: [] as unknown[],
  held: 0,
  opened: { created: true, claim: claimRow() } as { created: boolean; claim: ClaimRow },
  claims: [] as (ClaimRow | undefined)[],
  proven: claimRow({ status: 'PROVEN' }) as ClaimRow | undefined,
  reissued: undefined as ClaimRow | undefined,
  served: [] as { id: string; origin: string; transferAt: Date }[],
  withdrawn: undefined as string | undefined,
};

class ClaimRacedError extends Error {}

vi.mock('@catalogorosso/db', () => ({
  ClaimRacedError,
  withTenant: (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    calls.push(`withTenant(${tenantId})`);

    return fn({});
  },
  readDomainByOrigin: (_tx: unknown, origin: string) => {
    calls.push(`readDomainByOrigin(${origin})`);

    return Promise.resolve(state.own);
  },
  readTenantPlan: () => Promise.resolve(state.plan),
  readDomainsFor: () => Promise.resolve(state.covering),
  countDomains: () => Promise.resolve(state.held),
  insertClaim: (_tx: unknown, claim: { verificationToken: string }) => {
    calls.push(`insertClaim(${claim.verificationToken})`);

    return Promise.resolve(state.opened);
  },
  readClaimById: (_tx: unknown, id: string) => {
    calls.push(`readClaimById(${id})`);

    return Promise.resolve(state.claims.shift());
  },
  markClaimProven: (_tx: unknown, id: string, token: string) => {
    calls.push(`markClaimProven(${id},${token})`);

    return Promise.resolve(state.proven);
  },
  readServedClaims: () => {
    calls.push('readServedClaims');

    return Promise.resolve(state.served);
  },
  withdrawClaim: (_tx: unknown, id: string) => {
    calls.push(`withdrawClaim(${id})`);

    return Promise.resolve(state.withdrawn);
  },
  reissueClaimVerification: (_tx: unknown, id: string, token: string) => {
    calls.push(`reissueClaimVerification(${id},${token})`);

    return Promise.resolve(state.reissued);
  },
}));

const { createDomainsPort } = await import('../src/domains.js');
const { CLAIM_NOTICED, CLAIM_TRANSFERRED, CLAIM_WITHDRAWN } = await import('@catalogorosso/core');

interface Entry {
  readonly action: string;
  readonly target?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

const written: Entry[] = [];
const record = (_tx: unknown, entry: Entry) => {
  written.push(entry);

  return Promise.resolve();
};

const NOW = Date.parse('2026-09-29T09:00:00.000Z');

type Settlement =
  | { kind: 'unsettleable' }
  | { kind: 'at-cap'; held: number }
  | { kind: 'transferred'; domain: typeof domainRow; basis: string }
  | { kind: 'noticed'; transferAt: Date };

const settled: unknown[] = [];

interface PortOptions {
  readonly records?: string[][];
  /** A function stands for a settlement that throws. */
  readonly settlement?: Settlement | (() => never);
  readonly allowed?: boolean;
}

const port = ({
  records = [['the-nonce']],
  settlement = { kind: 'transferred', domain: domainRow, basis: 'lapsed' },
  allowed = true,
}: PortOptions = {}) =>
  createDomainsPort({
    audit: record,
    now: () => NOW,
    newToken: () => 'a-fresh-nonce',
    newResolver: () => () => {
      calls.push('resolveTxt');

      return Promise.resolve(records);
    },
    limiter: {
      check: () => {
        calls.push('limiter');

        return Promise.resolve({
          allowed,
          remaining: 0,
          resetAt: new Date(NOW),
          limit: 10,
          key: 'k',
        });
      },
    },
    settle: (input) => {
      settled.push(input);
      calls.push('settle');

      if (typeof settlement === 'function') return settlement();

      return Promise.resolve(settlement as never);
    },
  });

beforeEach(() => {
  calls.length = 0;
  written.length = 0;
  settled.length = 0;
  Object.assign(state, {
    own: undefined,
    plan: null,
    covering: [],
    held: 0,
    opened: { created: true, claim: claimRow() },
    claims: [],
    proven: claimRow({ status: 'PROVEN' }),
    reissued: undefined,
    served: [],
    withdrawn: undefined,
  });
});

describe('opening a claim', () => {
  it('opens one with a fresh nonce, and audits it', async () => {
    const result = await port().claim({ tenantId: 't1', input: 'WWW.Winery.com' });

    expect(result).toEqual({
      created: true,
      claim: {
        id: 'c1',
        origin: 'https://www.winery.com',
        registrableDomain: 'winery.com',
        status: 'PENDING',
        verificationToken: 'the-nonce',
        verificationExpiresAt: '2026-10-06T09:00:00.000Z',
        transferAt: null,
        createdAt: '2026-09-29T09:00:00.000Z',
      },
    });
    expect(calls).toContain('insertClaim(a-fresh-nonce)');
    expect(written).toEqual([
      {
        action: 'domain.claim_opened',
        target: 'https://www.winery.com',
        metadata: { registrableDomain: 'winery.com' },
      },
    ]);
  });

  it('hands back a claim already open without auditing a second opening', async () => {
    state.opened = { created: false, claim: claimRow() };

    await expect(port().claim({ tenantId: 't1', input: 'winery.com' })).resolves.toMatchObject({
      created: false,
    });
    expect(written).toEqual([]);
  });

  it('refuses a domain this winery already holds', async () => {
    state.own = domainRow;

    await expect(port().claim({ tenantId: 't1', input: 'www.winery.com' })).rejects.toMatchObject({
      kind: 'conflict',
      message: 'That domain is already on your account.',
    });
    expect(calls.some((call) => call.startsWith('insertClaim'))).toBe(false);
  });

  it('refuses at the plan cap, naming the plan', async () => {
    state.plan = 'CANTINA';
    state.held = 1;

    await expect(port().claim({ tenantId: 't1', input: 'winery.com' })).rejects.toMatchObject({
      kind: 'conflict',
    });
    expect(calls.some((call) => call.startsWith('insertClaim'))).toBe(false);
  });

  it('opens one at the cap when the registrable domain is already held', async () => {
    state.plan = 'CANTINA';
    state.held = 1;
    state.covering = [domainRow];

    await expect(port().claim({ tenantId: 't1', input: 'shop.winery.com' })).resolves.toMatchObject(
      { created: true },
    );
  });

  it('refuses a Shopify store’s own address, which DNS can never prove (P4-19)', async () => {
    await expect(
      port().claim({ tenantId: 't1', input: 'winery.myshopify.com' }),
    ).rejects.toMatchObject({
      kind: 'conflict',
      message: expect.stringContaining('Shopify') as unknown,
    });
    expect(calls).toEqual([]);
  });

  it('refuses what is not an origin before opening anything', async () => {
    await expect(port().claim({ tenantId: 't1', input: 'not a domain' })).rejects.toMatchObject({
      kind: 'invalid',
    });
    expect(calls).toEqual([]);
  });
});

describe('checking a claim', () => {
  it('is counted before anything is read', async () => {
    await expect(
      port({ allowed: false }).verifyClaim({ tenantId: 't1', claimId: 'c1' }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(calls).toEqual(['limiter']);
  });

  it('answers 404 for a claim it cannot see', async () => {
    state.claims = [undefined];

    await expect(port().verifyClaim({ tenantId: 't1', claimId: 'c1' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('proves a claim whose record is there, then settles it outside any tenant scope', async () => {
    state.claims = [claimRow(), claimRow({ status: 'TRANSFERRED', verificationToken: null })];

    const result = await port().verifyClaim({ tenantId: 't1', claimId: 'c1' });

    expect(result).toMatchObject({
      verified: true,
      transferred: true,
      reason: CLAIM_TRANSFERRED,
      domain: { id: 'd1', status: 'VERIFIED' },
      claim: { status: 'TRANSFERRED' },
    });
    expect(calls).toEqual([
      'limiter',
      'withTenant(t1)',
      'readClaimById(c1)',
      'resolveTxt',
      'withTenant(t1)',
      'markClaimProven(c1,the-nonce)',
      'withTenant(t1)',
      'settle',
      'withTenant(t1)',
      'readClaimById(c1)',
    ]);
    expect(settled).toEqual([
      expect.objectContaining({ claimId: 'c1', claimantTenantId: 't1', noticeHours: 72 }),
    ]);
    expect(written).toEqual([{ action: 'domain.claim_proven', target: 'https://www.winery.com' }]);
  });

  it('settles with the cap of the claimant’s own plan', async () => {
    state.plan = 'ECOMMERCE';
    state.claims = [claimRow(), claimRow({ status: 'TRANSFERRED' })];

    await port().verifyClaim({ tenantId: 't1', claimId: 'c1' });

    expect(settled).toEqual([expect.objectContaining({ cap: 2 })]);
  });

  it('does not audit a proof that another request recorded first', async () => {
    state.claims = [claimRow(), claimRow({ status: 'TRANSFERRED' })];
    state.proven = undefined;

    await port().verifyClaim({ tenantId: 't1', claimId: 'c1' });

    expect(written).toEqual([]);
    expect(calls).toContain('settle');
  });

  it('tells a claimant a paying holder is on notice, and when it ends', async () => {
    const transferAt = new Date('2026-10-02T09:00:00.000Z');
    state.claims = [
      claimRow(),
      claimRow({ status: 'NOTICE', transferAt, verificationToken: null }),
    ];

    const result = await port({ settlement: { kind: 'noticed', transferAt } }).verifyClaim({
      tenantId: 't1',
      claimId: 'c1',
    });

    const { claim, ...rest } = result;

    expect(claim).toMatchObject({ status: 'NOTICE', transferAt: transferAt.toISOString() });
    expect(rest).toEqual({
      verified: true,
      transferred: false,
      transferAt: transferAt.toISOString(),
      reason: CLAIM_NOTICED,
    });
  });

  it('keeps a claim proven at the cap, and says which cap', async () => {
    state.plan = 'CANTINA';
    state.claims = [claimRow()];

    await expect(
      port({ settlement: { kind: 'at-cap', held: 1 } }).verifyClaim({
        tenantId: 't1',
        claimId: 'c1',
      }),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('turns a race into a conflict to try again', async () => {
    state.claims = [claimRow()];
    const raced = (() => {
      throw new ClaimRacedError();
    }) as () => never;

    await expect(
      port({ settlement: raced }).verifyClaim({ tenantId: 't1', claimId: 'c1' }),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('passes on anything else the settlement throws', async () => {
    state.claims = [claimRow()];
    const broken = (() => {
      throw new Error('connection reset');
    }) as () => never;

    await expect(
      port({ settlement: broken }).verifyClaim({ tenantId: 't1', claimId: 'c1' }),
    ).rejects.toThrow('connection reset');
  });

  it('reports a record that is not there, audited as the claimant’s failure', async () => {
    state.claims = [claimRow()];

    const result = await port({ records: [] }).verifyClaim({ tenantId: 't1', claimId: 'c1' });

    expect(result).toMatchObject({ verified: false, transferred: false });
    expect(result.reason).toBeDefined();
    expect(calls).not.toContain('settle');
    expect(written).toEqual([
      {
        action: 'domain.claim_verify_failed',
        target: 'https://www.winery.com',
        metadata: { reason: 'no_record' },
      },
    ]);
  });

  it('records a resolver that failed as ours, not the claimant’s', async () => {
    state.claims = [claimRow()];

    const failing = createDomainsPort({
      audit: record,
      now: () => NOW,
      newResolver: () => () => Promise.reject(Object.assign(new Error('x'), { code: 'SERVFAIL' })),
    });

    await failing.verifyClaim({ tenantId: 't1', claimId: 'c1' });

    expect(written).toMatchObject([{ action: 'domain.claim_verify_error' }]);
  });

  it('replaces a lapsed nonce rather than checking it', async () => {
    state.claims = [claimRow({ verificationExpiresAt: new Date(NOW) })];
    state.reissued = claimRow({ verificationToken: 'a-fresh-nonce' });

    const result = await port().verifyClaim({ tenantId: 't1', claimId: 'c1' });

    expect(result).toMatchObject({
      verified: false,
      claim: { verificationToken: 'a-fresh-nonce' },
    });
    expect(calls).toContain('reissueClaimVerification(c1,a-fresh-nonce)');
    expect(calls).not.toContain('resolveTxt');
    expect(written).toEqual([
      {
        action: 'domain.claim_verification_reissued',
        target: 'https://www.winery.com',
        metadata: { reason: 'expired' },
      },
    ]);
  });

  it('answers with the claim as it was when a lapsed nonce could not be replaced', async () => {
    state.claims = [claimRow({ verificationExpiresAt: new Date(NOW) })];

    await expect(port().verifyClaim({ tenantId: 't1', claimId: 'c1' })).resolves.toMatchObject({
      claim: { verificationToken: 'the-nonce' },
    });
    expect(written).toEqual([]);
  });

  it('refuses a pending claim with no nonce', async () => {
    state.claims = [claimRow({ verificationToken: null })];

    await expect(port().verifyClaim({ tenantId: 't1', claimId: 'c1' })).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it.each([
    ['TRANSFERRED', { transferred: true, reason: CLAIM_TRANSFERRED }],
    ['CANCELED', { transferred: false, reason: CLAIM_WITHDRAWN }],
  ] as const)(
    'answers a %s claim as it stands, without looking anything up',
    async (status, shape) => {
      state.claims = [claimRow({ status, verificationToken: null })];

      await expect(port().verifyClaim({ tenantId: 't1', claimId: 'c1' })).resolves.toMatchObject({
        verified: true,
        ...shape,
      });
      expect(calls).not.toContain('resolveTxt');
      expect(calls).not.toContain('settle');
    },
  );

  it('never settles a notice, even one that has run out', async () => {
    /*
     * **A notice moves a paying winery's origin, and only once it has been
     * told** (P4-18b's sweep). Settling here would make the claimant's patience
     * the only thing between that winery and its origin.
     */
    const transferAt = new Date(NOW - 1);
    state.claims = [claimRow({ status: 'NOTICE', verificationToken: null, transferAt })];

    const result = await port().verifyClaim({ tenantId: 't1', claimId: 'c1' });

    expect(calls).not.toContain('resolveTxt');
    expect(calls).not.toContain('settle');
    expect(result).toMatchObject({
      verified: true,
      transferred: false,
      transferAt: transferAt.toISOString(),
      reason: CLAIM_NOTICED,
    });
  });

  it('settles a proven claim again without a second lookup', async () => {
    state.claims = [
      claimRow({ status: 'PROVEN', verificationToken: null }),
      claimRow({ status: 'TRANSFERRED', verificationToken: null }),
    ];

    await expect(port().verifyClaim({ tenantId: 't1', claimId: 'c1' })).resolves.toMatchObject({
      transferred: true,
    });
    expect(calls).not.toContain('resolveTxt');
    expect(calls).toContain('settle');
  });

  it('describes a proven claim with no notice as verified and waiting', async () => {
    state.claims = [
      claimRow({ status: 'PROVEN', verificationToken: null }),
      claimRow({ status: 'PROVEN', verificationToken: null }),
    ];

    const { claim, ...rest } = await port({ settlement: { kind: 'unsettleable' } }).verifyClaim({
      tenantId: 't1',
      claimId: 'c1',
    });

    expect(claim).toMatchObject({ status: 'PROVEN' });
    expect(rest).toEqual({ verified: true, transferred: false });
  });

  it('answers 404 if the claim vanished after it settled', async () => {
    state.claims = [claimRow({ status: 'PROVEN', verificationToken: null }), undefined];

    await expect(
      port({ settlement: { kind: 'unsettleable' } }).verifyClaim({ tenantId: 't1', claimId: 'c1' }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('the holder’s side (P4-18b)', () => {
  it('lists the notices served on it, with nothing about the claimant', async () => {
    state.served = [
      {
        id: 'c9',
        origin: 'https://www.ours.com',
        transferAt: new Date('2026-10-03T08:00:00.000Z'),
      },
    ];

    await expect(port().servedClaims('t1')).resolves.toEqual({
      claims: [
        { id: 'c9', origin: 'https://www.ours.com', transferAt: '2026-10-03T08:00:00.000Z' },
      ],
    });
    expect(calls).toEqual(['withTenant(t1)', 'readServedClaims']);
  });

  it('withdraws a notice and audits it in the same transaction', async () => {
    state.withdrawn = 'https://www.ours.com';

    await expect(port().withdrawClaim({ tenantId: 't1', claimId: 'c9' })).resolves.toEqual({
      id: 'c9',
      origin: 'https://www.ours.com',
      withdrawn: true,
    });
    expect(calls).toEqual(['withTenant(t1)', 'withdrawClaim(c9)']);
    expect(written).toEqual([{ action: 'domain.claim_withdrawn', target: 'https://www.ours.com' }]);
  });

  it('answers 404 for a claim it may not withdraw, and audits nothing', async () => {
    await expect(port().withdrawClaim({ tenantId: 't1', claimId: 'c9' })).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(written).toEqual([]);
  });
});
