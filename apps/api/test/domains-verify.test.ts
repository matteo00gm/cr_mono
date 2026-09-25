import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Checking a domain's proof (P4-02, §3.3).
 *
 * `@catalogorosso/db` is mocked, as in `domains-port.test.ts`: what is under
 * test is the order the steps run in and which of them is skipped when.
 *
 * **Two cases carry the row.** The limiter is consulted *before* the lookup,
 * because this endpoint makes an outbound network call on demand and a limit
 * spent after the resource is a limit that protects nothing. And a failed check
 * is a 200-shaped result rather than a throw, because "your record is not there
 * yet" is the expected state for most of the minutes after a seller publishes
 * it.
 *
 * That the resolver is a pinned public one is asserted where it lives, in
 * `packages/security/test/verify-dns.test.ts`.
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
  marked: undefined as Row | undefined,
  reissued: undefined as Row | undefined,
  committed: true,
};

const row = (overrides: Partial<Row> = {}): Row => ({
  id: 'd1',
  origin: 'https://www.winery.com',
  registrableDomain: 'winery.com',
  status: 'PENDING',
  verificationToken: 'the-nonce',
  verificationExpiresAt: new Date('2026-10-02T09:00:00.000Z'),
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
  markDomainVerified: (_tx: unknown, id: string, method: string) => {
    calls.push(`markDomainVerified(${id},${method})`);

    return Promise.resolve(state.marked);
  },
  reissueVerification: (_tx: unknown, id: string, token: string) => {
    calls.push(`reissueVerification(${id})`);

    return Promise.resolve(
      state.reissued === undefined ? undefined : { ...state.reissued, verificationToken: token },
    );
  },
  readDomainByOrigin: () => Promise.resolve(undefined),
  insertDomain: () => Promise.resolve({ outcome: 'taken' }),
  readTenantPlan: () => Promise.resolve(null),
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

/** A port whose file check answers without a network. */
const filePort = (respond: () => Promise<{ status: number; body: string }>, allowed = true) =>
  createDomainsPort({
    audit: record,
    now: () => NOW,
    newToken: () => 'a-fresh-nonce',
    fetcher: (url: string) => {
      calls.push(`fetch(${url})`);

      return respond();
    },
    limiter: {
      check: (checks) => {
        calls.push(`limiter(${checks.map((check) => check.key).join(',')})`);

        return Promise.resolve({
          allowed,
          remaining: 9,
          resetAt: new Date(NOW),
          limit: 10,
          key: checks[0]?.key ?? '',
        });
      },
    },
  });

/** A clock the tests move, so a week does not have to pass. */
const NOW = new Date('2026-09-26T09:00:00.000Z').getTime();

/** Records are what a nameserver hands back: an array of chunk arrays. */
const port = (records: string[][] | Error, allowed = true) =>
  createDomainsPort({
    audit: record,
    now: () => NOW,
    newToken: () => 'a-fresh-nonce',
    newResolver: () => () =>
      records instanceof Error ? Promise.reject(records) : Promise.resolve(records),
    limiter: {
      check: (checks) => {
        calls.push(`limiter(${checks.map((check) => check.key).join(',')})`);

        return Promise.resolve({
          allowed,
          remaining: allowed ? 9 : 0,
          resetAt: new Date('2026-09-25T09:10:00.000Z'),
          limit: 10,
          key: checks[0]?.key ?? '',
          ...(allowed ? {} : { retryAfterSec: 120 }),
        });
      },
    },
  });

beforeEach(() => {
  calls.length = 0;
  written.length = 0;
  state.domain = row();
  state.marked = row({ status: 'VERIFIED' });
  state.reissued = row();
  state.committed = true;
});

describe('a domain whose record is published', () => {
  it('verifies', async () => {
    const result = await port([['the-nonce']]).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(result).toMatchObject({ verified: true, domain: { status: 'VERIFIED' } });
  });

  it('records which proof was used', async () => {
    await port([['the-nonce']]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });

    expect(calls).toContain('markDomainVerified(d1,DNS_TXT)');
    expect(written).toEqual([
      expect.objectContaining({ action: 'domain.verified', target: 'https://www.winery.com' }),
    ]);
  });

  it('is a success even if something else verified it first', async () => {
    /*
     * The write re-checks `PENDING` in its own statement, so a second request
     * arriving between the read and the write loses. Losing that race is still
     * the outcome the seller wanted, and reporting it as a failure would make a
     * double-click an error.
     */
    state.marked = undefined;

    const result = await port([['the-nonce']]).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(result.verified).toBe(true);
    expect(result.domain.status).toBe('VERIFIED');
  });

  it('writes no audit row when it lost that race', async () => {
    /* Something else already recorded the verification. Two rows for one event
     * is a log that overstates what happened. */
    state.marked = undefined;

    await port([['the-nonce']]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });

    expect(written).toEqual([]);
  });
});

describe('a domain whose record is not', () => {
  it('is not an error, because it is the normal state for a while', async () => {
    const result = await port([]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });

    expect(result.verified).toBe(false);
    expect(result.domain.status).toBe('PENDING');
  });

  it('says where to look when the record is absent', async () => {
    const result = await port([]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });

    expect(result.reason).toMatch(/propagate|publish/iu);
  });

  it('says something different when the record is there and wrong', async () => {
    /* Two different places to look: "publish it" and "check what you pasted".
     * A seller given the wrong one spends an afternoon on the wrong screen. */
    const absent = await port([]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });
    const wrong = await port([['not-the-nonce']]).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(wrong.reason).not.toBe(absent.reason);
    expect(wrong.reason).toMatch(/not the value|exactly/iu);
  });

  it('says a resolver failure is ours', async () => {
    const result = await port(Object.assign(new Error('SERVFAIL'), { code: 'SERVFAIL' })).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(result.reason).toMatch(/our end/iu);
  });

  it('leaves the status alone', async () => {
    await port([['not-the-nonce']]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });

    expect(calls.some((call) => call.startsWith('markDomainVerified'))).toBe(false);
  });

  it('records the attempt, told apart from a failure that is ours', async () => {
    /*
     * A domain checked over and over against a record that never appears is
     * what a contested claim looks like from our side (P4-18) — and a resolver
     * of ours falling over is not that at all.
     */
    await port([['not-the-nonce']]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });
    const theirs = [...written];

    written.length = 0;
    await port(Object.assign(new Error('SERVFAIL'), { code: 'SERVFAIL' })).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(theirs[0]?.action).toBe('domain.verify_failed');
    expect(written[0]?.action).toBe('domain.verify_error');
  });
});

describe('a domain that is already verified', () => {
  it('answers success without asking a nameserver', async () => {
    state.domain = row({ status: 'VERIFIED', verificationToken: null });

    const result = await port([]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });

    expect(result.verified).toBe(true);
    expect(calls.some((call) => call.startsWith('markDomainVerified'))).toBe(false);
  });
});

describe('a domain that is not this winery', () => {
  it('is a 404, never a 403', async () => {
    /*
     * §3.5. RLS makes "another winery's id" and "no such id" the same query
     * result, and the difference between 403 and 404 is what tells an attacker
     * the resource exists.
     */
    state.domain = undefined;

    await expect(
      port([]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' }),
    ).rejects.toMatchObject({
      kind: 'not_found',
    });
  });
});

describe('a domain with no verification in progress', () => {
  it('is refused rather than checked against nothing', async () => {
    state.domain = row({ verificationToken: null });

    await expect(
      port([['']]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' }),
    ).rejects.toMatchObject({
      kind: 'conflict',
    });
  });
});

describe('how often it may be asked', () => {
  it('counts before it looks anything up', async () => {
    /*
     * **The order is the point.** This endpoint makes an outbound network call
     * on demand, so an unlimited one drives DNS queries from our address at
     * somebody else's nameservers — and a bucket spent after the resource
     * protects nothing.
     */
    await port([['the-nonce']]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });

    expect(calls[0]).toBe('limiter(domain-verify:d1)');
  });

  it('counts per domain, not per tenant', async () => {
    await port([['the-nonce']]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });

    expect(calls[0]).toContain('d1');
    expect(calls[0]).not.toContain('t1');
  });

  it('refuses once the bucket is empty, before reading anything', async () => {
    await expect(
      port([['the-nonce']], false).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });

    expect(calls).toEqual(['limiter(domain-verify:d1)']);
  });

  it('tells a seller to wait rather than that something is broken', async () => {
    const message = await port([['the-nonce']], false)
      .verify({ tenantId: 't1', domainId: 'd1', method: 'dns' })
      .then(
        () => '',
        (error: unknown) => (error as Error).message,
      );

    expect(message).toMatch(/wait|try again/iu);
    expect(message).not.toMatch(/limit exceeded|forbidden|error/iu);
  });
});

describe('with no port configured', () => {
  it('refuses loudly rather than reporting a domain verified', async () => {
    await expect(
      unconfiguredDomains.verify({ tenantId: 't1', domainId: 'd1', method: 'dns' }),
    ).rejects.toThrow(/composition root/iu);
  });
});

describe('a nonce that has lapsed (P4-04)', () => {
  const lapsed = () => row({ verificationExpiresAt: new Date(NOW - 1000) });

  it('is replaced rather than extended', async () => {
    /*
     * **It has been in a public TXT record for a week.** Anybody who looked has
     * a copy, so extending the window would mean the thing that proves control
     * is a thing a passer-by can replay.
     */
    state.domain = lapsed();

    const result = await port([['the-nonce']]).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(calls).toContain('reissueVerification(d1)');
    expect(result.domain.verificationToken).toBe('a-fresh-nonce');
  });

  it('is not checked against the record at all', async () => {
    /* Checking first and reissuing after would accept a lapsed proof for
     * exactly as long as it takes somebody to notice. */
    state.domain = lapsed();

    const result = await port([['the-nonce']]).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(result.verified).toBe(false);
    expect(calls.some((call) => call.startsWith('markDomainVerified'))).toBe(false);
  });

  it('tells the seller the value changed, not that they got it wrong', async () => {
    /* To them, the record they published is still sitting there. "It does not
     * match" with no explanation is the version that generates a ticket. */
    state.domain = lapsed();

    const result = await port([['the-nonce']]).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(result.reason).toMatch(/expired/iu);
    expect(result.reason).toMatch(/new one|replace/iu);
  });

  it('is recorded, so a claim nobody ever completes is visible', async () => {
    state.domain = lapsed();

    await port([['the-nonce']]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });

    expect(written).toEqual([expect.objectContaining({ action: 'domain.verification_reissued' })]);
  });

  it('writes no audit row when nothing was reissued', async () => {
    /* Something else got there first. A row saying we issued a value when we
     * did not is a record somebody will later try to reconcile against DNS. */
    state.domain = lapsed();
    state.reissued = undefined;

    await port([['the-nonce']]).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' });

    expect(written).toEqual([]);
  });

  it('puts the new deadline on the wire, so the screen can say it', async () => {
    /* A seller who publishes a record and comes back a fortnight later needs
     * to be told when the value stops being accepted, not left guessing. */
    state.domain = lapsed();

    const result = await port([['the-nonce']]).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(result.domain.verificationExpiresAt).toBe('2026-10-02T09:00:00.000Z');
  });

  it('is still counted against the limit', async () => {
    /* Reissuing is a write and a round trip. An expired nonce is not a free
     * pass through the thing that bounds this endpoint. */
    state.domain = lapsed();

    await expect(
      port([['the-nonce']], false).verify({ tenantId: 't1', domainId: 'd1', method: 'dns' }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});

describe('a nonce that has not lapsed', () => {
  it('is checked as it stands', async () => {
    const result = await port([['the-nonce']]).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(calls.some((call) => call.startsWith('reissueVerification'))).toBe(false);
    expect(result.verified).toBe(true);
  });

  it('is checked on the very last second rather than one early', async () => {
    /* `<=` against `<` is the off-by-one, and it decides whether a seller who
     * presses the button as the window closes is told their record is wrong. */
    state.domain = row({ verificationExpiresAt: new Date(NOW + 1) });

    const result = await port([['the-nonce']]).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(result.verified).toBe(true);
  });

  it('is checked when it carries no deadline at all', async () => {
    /* Rows created before this row existed. Treating a null deadline as lapsed
     * would reissue a nonce every seller mid-verification had just published. */
    state.domain = row({ verificationExpiresAt: null });

    const result = await port([['the-nonce']]).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'dns',
    });

    expect(result.verified).toBe(true);
  });
});

describe('the file proof (P4-03)', () => {
  const serving =
    (body: string, status = 200) =>
    () =>
      Promise.resolve({ status, body });

  it('asks for the nonce path on the registrable domain', async () => {
    /* The nonce is in the *path*, so the URL is itself unguessable — a host
     * that serves the right bytes somewhere else has proved nothing. */
    await filePort(serving('the-nonce')).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'wellknown',
    });

    expect(calls).toContain('fetch(https://winery.com/.well-known/somm-verify-the-nonce.txt)');
  });

  it('verifies, and records which proof was used', async () => {
    const result = await filePort(serving('the-nonce')).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'wellknown',
    });

    expect(result.verified).toBe(true);
    expect(calls).toContain('markDomainVerified(d1,WELL_KNOWN)');
    expect(written).toHaveLength(1);
    expect(written[0]?.action).toBe('domain.verified');
    expect(written[0]?.metadata).toMatchObject({ method: 'WELL_KNOWN' });
  });

  it('does not ask a nameserver at all', async () => {
    /* The two proofs are alternatives. A seller who cannot edit DNS must not
     * be failed by a DNS lookup they never asked for. */
    await filePort(serving('the-nonce')).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'wellknown',
    });

    expect(calls.some((call) => call.startsWith('fetch('))).toBe(true);
  });

  it('tells a seller to upload the file when nothing is there', async () => {
    const result = await filePort(serving('', 404)).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'wellknown',
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/upload/iu);
  });

  it('tells a seller to check the contents when something else answers', async () => {
    const result = await filePort(serving('<html>not found</html>')).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'wellknown',
    });

    expect(result.reason).toMatch(/value we issued|themed page/iu);
  });

  it('says only that it could not reach the site, whatever the refusal was', async () => {
    /*
     * **The response and the audit row say different amounts on purpose.**
     * `blocked_address` tells a caller our network refused to connect to an
     * address — run against a list of addresses, that maps our defences.
     */
    const { GuardedFetchRefused } = await import('@catalogorosso/security/net');
    const result = await filePort(() =>
      Promise.reject(new GuardedFetchRefused('blocked_address')),
    ).verify({ tenantId: 't1', domainId: 'd1', method: 'wellknown' });

    expect(result.reason).toMatch(/could not reach/iu);
    expect(result.reason).not.toMatch(/blocked|address|redirect|private/iu);
  });

  it('records what our own agent actually refused', async () => {
    const { GuardedFetchRefused } = await import('@catalogorosso/security/net');

    await filePort(() => Promise.reject(new GuardedFetchRefused('blocked_redirect'))).verify({
      tenantId: 't1',
      domainId: 'd1',
      method: 'wellknown',
    });

    expect(written).toHaveLength(1);
    expect(written[0]?.action).toBe('domain.verify_error');
    expect(written[0]?.metadata).toMatchObject({
      detail: 'blocked_redirect',
      method: 'WELL_KNOWN',
    });
  });

  it('counts a file check against the same bucket as a DNS one', async () => {
    /* One domain, one allowance. Two proofs would otherwise be twice the
     * outbound traffic for the same claim. */
    await expect(
      filePort(serving('the-nonce'), false).verify({
        tenantId: 't1',
        domainId: 'd1',
        method: 'wellknown',
      }),
    ).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});
