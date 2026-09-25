import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The database-backed domains port (P4-01, §3.3).
 *
 * `@catalogorosso/db` is mocked for the reason `members-port.test.ts` gives:
 * what is under test is *composition* — the order the steps run in, which
 * refusal is returned rather than thrown, and what reaches the audit log. The
 * behaviour that belongs to Postgres — that an origin another winery holds is
 * invisible to a `SELECT` and refused by the unique index — is asserted against
 * a real database in `packages/db/test/domains.integration.test.ts`.
 *
 * **The case this file exists for is the refused one.** An origin somebody else
 * holds has to produce a response that says nothing and an audit row that says
 * everything, and those two pull in opposite directions: the obvious
 * implementation throws inside the transaction, which rolls the audit row back.
 */

const calls: string[] = [];

interface Row {
  id: string;
  origin: string;
  registrableDomain: string;
  status: 'PENDING' | 'VERIFIED';
  verificationToken: string | null;
  createdAt: Date;
}

const state = {
  existing: undefined as Row | undefined,
  inserted: undefined as Row | undefined,
  committed: true,
  plan: null as 'CANTINA' | 'ECOMMERCE' | null,
  atCap: false,
  /** What the insert was actually handed, which the response does not echo. */
  written: undefined as
    { origin: string; registrableDomain: string; verificationToken: string } | undefined,
  /** The cap the port computed, which is the thing the plan table decides. */
  cap: undefined as number | undefined,
};

const row = (origin: string, overrides: Partial<Row> = {}): Row => ({
  id: 'd1',
  origin,
  registrableDomain: 'winery.com',
  status: 'PENDING',
  verificationToken: 'nonce',
  createdAt: new Date('2026-09-25T09:00:00.000Z'),
  ...overrides,
});

vi.mock('@catalogorosso/db', () => ({
  /*
   * The fake rolls back on a throw, exactly as a transaction does. Without
   * that, the port could throw inside the callback and the audit row would
   * still appear to have been written — which is the bug this suite is for.
   */
  withTenant: async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    calls.push(`withTenant(${tenantId})`);

    try {
      return await fn({});
    } catch (error) {
      state.committed = false;
      throw error;
    }
  },
  readDomainByOrigin: (_tx: unknown, origin: string) => {
    calls.push(`readDomainByOrigin(${origin})`);
    return Promise.resolve(state.existing);
  },
  insertDomain: (
    _tx: unknown,
    domain: { origin: string; registrableDomain: string; verificationToken: string },
    cap: number,
  ) => {
    calls.push(`insertDomain(${domain.origin})`);
    state.written = domain;
    state.cap = cap;

    if (state.atCap) return Promise.resolve({ outcome: 'at-cap', held: cap });

    return Promise.resolve(
      state.inserted === undefined
        ? { outcome: 'taken' }
        : { outcome: 'created', domain: state.inserted },
    );
  },
  readTenantPlan: () => {
    calls.push('readTenantPlan');

    return Promise.resolve(state.plan);
  },
}));

const { createDomainsPort, unconfiguredDomains } = await import('../src/domains.js');

interface Entry {
  readonly action: string;
  readonly target?: string | undefined;
}

const written: Entry[] = [];

const record = (_tx: unknown, entry: Entry) => {
  written.push(entry);

  return Promise.resolve();
};

const port = (environment?: 'production' | 'development') =>
  createDomainsPort({
    audit: record,
    ...(environment === undefined ? {} : { environment }),
    newToken: () => 'a-fixed-nonce',
  });

/** What survived the transaction, which is the only thing an audit log holds. */
const recorded = (): readonly Entry[] => (state.committed ? written : []);

beforeEach(() => {
  calls.length = 0;
  written.length = 0;
  state.existing = undefined;
  state.inserted = undefined;
  state.written = undefined;
  state.cap = undefined;
  state.plan = null;
  state.atCap = false;
  state.committed = true;
});

describe('adding a domain', () => {
  it('normalises what the seller typed before anything else', async () => {
    state.inserted = row('https://www.winery.com');

    const result = await port().add({ tenantId: 't1', input: '  WWW.Winery.COM.  ' });

    expect(result.created).toBe(true);
    expect(result.domain.origin).toBe('https://www.winery.com');
    expect(calls).toContain('insertDomain(https://www.winery.com)');
  });

  it('stores the registrable domain, which is what a later subdomain rests on', async () => {
    /*
     * **Asserted against what was written, not against what came back.** The
     * response echoes the stored row, so a port that wrote the whole host here
     * would still answer correctly — and proving control of `winery.com` is
     * exactly what lets `shop.winery.com` be added later without a second
     * round of DNS (§3.3).
     */
    state.inserted = row('https://shop.winery.com');

    await port().add({ tenantId: 't1', input: 'shop.winery.com' });

    expect(state.written).toMatchObject({
      origin: 'https://shop.winery.com',
      registrableDomain: 'winery.com',
    });
  });

  it('stores the nonce it generated, not one the caller chose', async () => {
    state.inserted = row('https://winery.com');

    await port().add({ tenantId: 't1', input: 'winery.com' });

    expect(state.written?.verificationToken).toBe('a-fixed-nonce');
  });

  it('gives back a date a browser can read, not a Date', async () => {
    state.inserted = row('https://winery.com');

    const result = await port().add({ tenantId: 't1', input: 'winery.com' });

    expect(result.domain.createdAt).toBe('2026-09-25T09:00:00.000Z');
  });

  it('never opens a transaction for input that cannot be an origin', async () => {
    await expect(port().add({ tenantId: 't1', input: 'winery' })).rejects.toMatchObject({
      kind: 'invalid',
    });

    /* Nothing was attempted against our data, so there is nothing to audit. */
    expect(calls).toEqual([]);
    expect(recorded()).toEqual([]);
  });

  it('says what was wrong, in words a seller can act on', async () => {
    const refusals: readonly (readonly [string, string])[] = [
      ['winery', 'suffix'],
      ['com', 'suffix'],
      ['http://winery.com', 'https'],
      ['https://192.168.1.1', 'IP address'],
      ['https://winery.com/shop', 'path'],
      ['https://localhost', 'localhost'],
    ];

    for (const [input, fragment] of refusals) {
      await expect(port().add({ tenantId: 't1', input })).rejects.toThrow(
        new RegExp(fragment, 'iu'),
      );
    }
  });

  it('admits http and localhost only where the widget would also be served', async () => {
    /*
     * The two halves of one rule. An origin a seller may add and an origin the
     * widget may be served to are the same set, so a local run that added
     * `localhost` against a production normaliser would create a row the widget
     * then refuses to load on.
     */
    state.inserted = row('http://localhost:3000');

    const local = await port('development').add({
      tenantId: 't1',
      input: 'http://localhost:3000',
    });

    expect(local.domain.origin).toBe('http://localhost:3000');

    await expect(
      port('production').add({ tenantId: 't1', input: 'http://localhost:3000' }),
    ).rejects.toThrow(/https/iu);
  });

  it('defaults to the strict answer when nobody says which environment it is', async () => {
    await expect(port().add({ tenantId: 't1', input: 'http://localhost:3000' })).rejects.toThrow();
  });
});

describe('an origin the winery already holds', () => {
  it('is answered with the row it has, not a conflict', async () => {
    state.existing = row('https://winery.com', { id: 'already', verificationToken: 'old-nonce' });

    const result = await port().add({ tenantId: 't1', input: 'winery.com' });

    expect(result).toMatchObject({ created: false, domain: { id: 'already' } });
    /* The token they came back for. */
    expect(result.domain.verificationToken).toBe('old-nonce');
  });

  it('is not inserted again', async () => {
    state.existing = row('https://winery.com');

    await port().add({ tenantId: 't1', input: 'winery.com' });

    expect(calls.some((call) => call.startsWith('insertDomain'))).toBe(false);
  });
});

describe('an origin another winery holds', () => {
  /*
   * **The response and the audit row say opposite things on purpose.** The
   * seller is told only that it is unavailable; we record exactly what was
   * attempted, because a run of these is what enumeration looks like.
   */
  it('is refused without naming anybody', async () => {
    const message = await port()
      .add({ tenantId: 't1', input: 'winery.com' })
      .then(
        () => 'it was not refused at all',
        (error: unknown) => (error as Error).message,
      );

    expect(message).not.toMatch(/tenant|winery\.com|another|owner|belongs|taken/iu);
  });

  it('is a conflict rather than a validation failure', async () => {
    await expect(port().add({ tenantId: 't1', input: 'winery.com' })).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('is recorded, and the record survives the refusal', async () => {
    /*
     * **The bug this kills.** Throwing the conflict inside the transaction
     * rolls back the audit row that records it — so the one attempt worth
     * seeing is the one attempt nothing would have written down.
     */
    await expect(port().add({ tenantId: 't1', input: 'winery.com' })).rejects.toThrow();

    expect(recorded()).toEqual([
      expect.objectContaining({ action: 'domain.add_taken', target: 'https://winery.com' }),
    ]);
  });
});

describe('the audit row', () => {
  it('records a successful add against the origin itself', async () => {
    state.inserted = row('https://winery.com');

    await port().add({ tenantId: 't1', input: 'winery.com' });

    expect(recorded()).toEqual([
      expect.objectContaining({ action: 'domain.added', target: 'https://winery.com' }),
    ]);
  });

  it('is not written when the row already existed', async () => {
    state.existing = row('https://winery.com');

    await port().add({ tenantId: 't1', input: 'winery.com' });

    /* Nothing changed, so there is nothing to record. An entry here would make
     * the log report an addition every time the screen is opened. */
    expect(recorded()).toEqual([]);
  });
});

describe('the plan cap', () => {
  it('is the entry allowance for a winery that has not chosen a plan', async () => {
    /* Every winery is this between signup and checkout, and one that cannot add
     * the domain it came to add cannot try the product at all. */
    state.inserted = row('https://winery.com');
    state.plan = null;

    await port().add({ tenantId: 't1', input: 'winery.com' });

    expect(state.cap).toBe(1);
  });

  it('is the plan own allowance otherwise', async () => {
    state.inserted = row('https://winery.com');
    state.plan = 'ECOMMERCE';

    await port().add({ tenantId: 't1', input: 'winery.com' });

    expect(state.cap).toBe(2);
  });

  it('comes from the winery own row, never from the caller', async () => {
    state.inserted = row('https://winery.com');

    await port().add({ tenantId: 't1', input: 'winery.com' });

    expect(calls).toContain('readTenantPlan');
  });

  it('names the plan and the number when it refuses', async () => {
    /*
     * **The opposite of the other refusal, on purpose.** A cap is the seller's
     * own state, so saying which plan and how many is what lets them act on it.
     * An origin somebody else holds is not their state, and naming anything
     * about it would be an oracle.
     */
    state.atCap = true;
    state.plan = 'CANTINA';

    const message = await port()
      .add({ tenantId: 't1', input: 'winery.com' })
      .then(
        () => '',
        (error: unknown) => (error as Error).message,
      );

    expect(message).toMatch(/Cantina/u);
    expect(message).toMatch(/1 domain\b/u);
    expect(message).toMatch(/Fatturazione/u);
  });

  it('is a conflict, and the attempt is recorded', async () => {
    state.atCap = true;
    state.plan = 'ECOMMERCE';

    await expect(port().add({ tenantId: 't1', input: 'winery.com' })).rejects.toMatchObject({
      kind: 'conflict',
    });

    expect(recorded()).toEqual([
      expect.objectContaining({ action: 'domain.add_at-cap', target: 'https://winery.com' }),
    ]);
  });

  it('does not stop a winery seeing a domain it already holds', async () => {
    /* The cap governs adding, not looking. A seller at their cap reopening the
     * screen still needs the token for the domain they are verifying. */
    state.atCap = true;
    state.existing = row('https://winery.com', { verificationToken: 'old-nonce' });

    const result = await port().add({ tenantId: 't1', input: 'winery.com' });

    expect(result.domain.verificationToken).toBe('old-nonce');
  });
});

describe('with no port configured', () => {
  it('refuses loudly rather than accepting quietly', async () => {
    await expect(unconfiguredDomains.add({ tenantId: 't1', input: 'winery.com' })).rejects.toThrow(
      /composition root/iu,
    );
  });
});
