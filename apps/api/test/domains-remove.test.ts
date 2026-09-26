import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Removing a domain (P4-06, §3.3).
 *
 * **The property this row is for is that removal is immediate**, and the
 * interesting part is that it already was: CORS resolves the allowlist uncached
 * on every request, so an origin removed a second ago is refused before a token
 * is read. That is a consequence of another row's design rather than a
 * guarantee of this one — §5.7 contemplates caching the allowlist, and the day
 * that cache exists the immediacy quietly becomes "within the TTL".
 *
 * So the cutoff is what is asserted here: that it is written, that it shares a
 * transaction with the delete, and that it outlives the row it came from.
 */

const calls: string[] = [];

interface Row {
  id: string;
  origin: string;
  registrableDomain: string;
  status: 'PENDING' | 'VERIFIED';
  verificationToken: string | null;
  verificationExpiresAt: Date | null;
  createdAt: Date;
}

const state = {
  domain: undefined as Row | undefined,
  deleted: undefined as Row | undefined,
  verified: 2,
  committed: true,
};

const row = (overrides: Partial<Row> = {}): Row => ({
  id: 'd1',
  origin: 'https://www.winery.com',
  registrableDomain: 'winery.com',
  status: 'VERIFIED',
  verificationToken: null,
  verificationExpiresAt: null,
  createdAt: new Date('2026-09-25T09:00:00.000Z'),
  ...overrides,
});

vi.mock('@catalogorosso/db', () => ({
  withTenant: async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    calls.push(`withTenant(${tenantId})`);

    try {
      return await fn({});
    } catch (error) {
      state.committed = false;
      throw error;
    }
  },
  readDomainById: (_tx: unknown, id: string) => {
    calls.push(`readDomainById(${id})`);

    return Promise.resolve(state.domain);
  },
  countVerifiedDomains: () => {
    calls.push('countVerifiedDomains');

    return Promise.resolve(state.verified);
  },
  deleteDomain: (_tx: unknown, id: string) => {
    calls.push(`deleteDomain(${id})`);

    return Promise.resolve(state.deleted);
  },
  endSessionsFor: (_tx: unknown, origin: string) => {
    calls.push(`endSessionsFor(${origin})`);

    return Promise.resolve();
  },
  /* Unused here, present because the port imports them. */
  insertDomain: () => Promise.resolve({ outcome: 'taken' }),
  insertVerifiedSibling: () => Promise.resolve(undefined),
  markDomainVerified: () => Promise.resolve(undefined),
  readDomainByOrigin: () => Promise.resolve(undefined),
  readDomainsFor: () => Promise.resolve([]),
  readTenantPlan: () => Promise.resolve(null),
  reissueVerification: () => Promise.resolve(undefined),
}));

const { createDomainsPort, unconfiguredDomains } = await import('../src/domains.js');

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

const port = () => createDomainsPort({ audit: record });

/** What survived the transaction, which is the only thing an audit log holds. */
const recorded = (): readonly Entry[] => (state.committed ? written : []);

beforeEach(() => {
  calls.length = 0;
  written.length = 0;
  state.domain = row();
  state.deleted = row();
  state.verified = 2;
  state.committed = true;
});

describe('removing a domain', () => {
  it('deletes the row and ends its sessions', async () => {
    const result = await port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false });

    expect(result).toEqual({
      origin: 'https://www.winery.com',
      removed: true,
      sessionsEnded: true,
      verifiedRemaining: 1,
    });
    expect(calls).toContain('deleteDomain(d1)');
    expect(calls).toContain('endSessionsFor(https://www.winery.com)');
  });

  it('writes the cutoff in the same transaction as the delete', async () => {
    /*
     * **A removal that committed without its cutoff would leave live sessions
     * answering on an origin the seller can no longer see** — which is the
     * failure this row exists to prevent, arriving by the back door.
     */
    await port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false });

    const opened = calls.indexOf('withTenant(t1)');
    const deleted = calls.indexOf('deleteDomain(d1)');
    const cutoff = calls.indexOf('endSessionsFor(https://www.winery.com)');

    expect(deleted).toBeGreaterThan(opened);
    expect(cutoff).toBeGreaterThan(deleted);
    /* One transaction, not two. */
    expect(calls.filter((call) => call.startsWith('withTenant'))).toHaveLength(1);
  });

  it('writes the cutoff against the stored origin, not the id', async () => {
    /* The row is gone afterwards. A cutoff keyed on anything the delete takes
     * with it would revoke nothing. */
    state.deleted = row({ origin: 'https://shop.winery.com' });

    await port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false });

    expect(calls).toContain('endSessionsFor(https://shop.winery.com)');
  });

  it('records the removal', async () => {
    await port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false });

    expect(recorded()).toEqual([
      expect.objectContaining({ action: 'domain.removed', target: 'https://www.winery.com' }),
    ]);
  });

  it('takes the tenant from the command, never from the id', async () => {
    await port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false });

    expect(calls[0]).toBe('withTenant(t1)');
  });
});

describe('a domain that is not this winery', () => {
  it('is a 404, never a 403', async () => {
    /* §3.5: RLS makes "another winery's id" and "no such id" the same empty
     * result, and the difference between the two answers tells an attacker the
     * resource exists. */
    state.domain = undefined;

    await expect(
      port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('deletes nothing and ends no sessions', async () => {
    state.domain = undefined;

    await expect(
      port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false }),
    ).rejects.toThrow();

    expect(calls.some((call) => call.startsWith('deleteDomain'))).toBe(false);
    expect(calls.some((call) => call.startsWith('endSessionsFor'))).toBe(false);
  });

  it('is a 404 when the delete itself matched nothing', async () => {
    /* The read and the delete are two statements. Something could have removed
     * it in between, and reporting success for a row nobody deleted would tell
     * a seller their widget is off when it is not. */
    state.deleted = undefined;

    await expect(
      port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('the last verified domain', () => {
  it('is refused without confirmation', async () => {
    /*
     * **A confirmation, not a refusal.** It is their domain and their decision
     * — what they must not be able to do is make it by accident, because the
     * consequence is a widget that stops answering on a live storefront with no
     * sign anywhere that somebody switched it off.
     */
    state.verified = 1;

    await expect(
      port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false }),
    ).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('says what removing it does, and how to proceed', async () => {
    state.verified = 1;

    const message = await port()
      .remove({ tenantId: 't1', domainId: 'd1', confirmed: false })
      .then(
        () => '',
        (error: unknown) => (error as Error).message,
      );

    expect(message).toMatch(/only verified domain/iu);
    expect(message).toMatch(/confirm/iu);
  });

  it('deletes nothing while it is refused', async () => {
    state.verified = 1;

    await expect(
      port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false }),
    ).rejects.toThrow();

    expect(calls.some((call) => call.startsWith('deleteDomain'))).toBe(false);
  });

  it('goes ahead once confirmed, and says nothing is left', async () => {
    state.verified = 1;

    const result = await port().remove({ tenantId: 't1', domainId: 'd1', confirmed: true });

    expect(result.verifiedRemaining).toBe(0);
    expect(calls).toContain('endSessionsFor(https://www.winery.com)');
  });

  it('records that it was the last one', async () => {
    /* The one removal an incident review will ask about. */
    state.verified = 1;

    await port().remove({ tenantId: 't1', domainId: 'd1', confirmed: true });

    expect(recorded()[0]?.metadata).toMatchObject({ wasLastVerified: true });
  });
});

describe('a pending claim', () => {
  it('needs no confirmation, whatever else is verified', async () => {
    /*
     * A widget is not running on a claim nobody finished, so warning that
     * removing it switches something off would be a warning about a consequence
     * that does not exist.
     */
    state.domain = row({ status: 'PENDING' });
    state.deleted = row({ status: 'PENDING' });
    state.verified = 0;

    await expect(
      port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false }),
    ).resolves.toMatchObject({ removed: true });
  });

  it('leaves the verified count alone', async () => {
    state.domain = row({ status: 'PENDING' });
    state.deleted = row({ status: 'PENDING' });
    state.verified = 2;

    const result = await port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false });

    expect(result.verifiedRemaining).toBe(2);
  });

  it('still ends its sessions', async () => {
    /* Nothing should have one — but "should" is not a guarantee, and the cutoff
     * costs one row. */
    state.domain = row({ status: 'PENDING' });
    state.deleted = row({ status: 'PENDING' });

    await port().remove({ tenantId: 't1', domainId: 'd1', confirmed: false });

    expect(calls).toContain('endSessionsFor(https://www.winery.com)');
  });
});

describe('with no port configured', () => {
  it('refuses loudly rather than reporting a domain removed', async () => {
    await expect(
      unconfiguredDomains.remove({ tenantId: 't1', domainId: 'd1', confirmed: true }),
    ).rejects.toThrow(/composition root/iu);
  });
});
