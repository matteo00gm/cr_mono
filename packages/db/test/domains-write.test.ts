import { describe, expect, it, vi } from 'vitest';

import {
  countDomains,
  insertDomain,
  markDomainVerified,
  readDomainById,
  readDomainByOrigin,
  readDomains,
  readTenantPlan,
} from '../src/domains-write.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The domain statements, without a database (P4-01).
 *
 * Shapes and branches only. **Whether an origin another winery holds is
 * actually invisible to the read, and whether `ON CONFLICT DO NOTHING` really
 * leaves the transaction usable, cannot be asserted here** — a fake executes
 * whatever it is handed and returns whatever it was told to. Both live in
 * `domains.integration.test.ts`, against real Postgres and real policies.
 *
 * What is worth asserting here is the shape of the statements themselves: that
 * the insert takes its tenant from the GUC rather than from an argument, and
 * that the reads name no tenant at all.
 */

const capturing = (...responses: unknown[][]) => {
  const statements: unknown[] = [];
  let call = 0;
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);

    const rows = responses[call] ?? [];

    call += 1;

    return Promise.resolve(rows);
  });

  return { statements, execute, tx: { execute } as unknown as DbTransaction };
};

/** The literal SQL of a statement, with its bound values elided. */
const text = (statement: unknown): string =>
  ((statement as { queryChunks?: unknown[] }).queryChunks ?? [])
    .flatMap((chunk) =>
      typeof chunk === 'object' &&
      chunk !== null &&
      Array.isArray((chunk as { value?: unknown[] }).value)
        ? ((chunk as { value: unknown[] }).value as string[])
        : [],
    )
    .join(' ');

const raw = {
  id: 'd1',
  origin: 'https://www.winery.com',
  registrable_domain: 'winery.com',
  status: 'PENDING',
  verification_token: 'a-nonce',
  created_at: new Date('2026-09-25T09:00:00.000Z'),
};

/**
 * The three statements an insert issues, in order: the lock, the count, the
 * insert itself. Naming them here rather than indexing by number means a
 * statement added in front of the lock breaks these tests loudly.
 */
const LOCK = 0;
const COUNT = 1;
const INSERT = 2;

/** An insert against a winery holding `held` origins, under a cap of `cap`. */
const adding = (rows: unknown[], held = 0, cap = 2) => {
  const captured = capturing([], [{ held }], rows);
  const result = insertDomain(
    captured.tx,
    {
      origin: 'https://www.winery.com',
      registrableDomain: 'winery.com',
      verificationToken: 'a-nonce',
    },
    cap,
  );

  return { ...captured, result };
};

describe('inserting a domain', () => {
  it('takes its tenant from the GUC, never from an argument', async () => {
    /*
     * The statement names no tenant (P0-19, P0-48). A caller outside
     * `withTenant` therefore writes nothing at all, rather than writing a row
     * attributed to whatever it happened to pass.
     */
    const { statements, result } = adding([raw]);

    await result;

    expect(text(statements[INSERT])).toMatch(/current_setting\('app\.tenant_id', true\)/u);
    expect(text(statements[INSERT])).not.toMatch(/tenant_id\s*=/u);
  });

  it('asks the unique index rather than raising on it', async () => {
    /* `DO NOTHING`, because a raised 23505 aborts the transaction the audit row
     * has to share (P0-53). `DO UPDATE` would hand a returning seller a new
     * nonce for a DNS record they have already published. */
    const { statements, result } = adding([raw]);

    await result;

    expect(text(statements[INSERT])).toMatch(/ON CONFLICT \(origin\) DO NOTHING/u);
    expect(text(statements[INSERT])).not.toMatch(/DO UPDATE/u);
  });

  it('maps the row back into the shape the application uses', async () => {
    const { result } = adding([raw]);

    await expect(result).resolves.toEqual({
      outcome: 'created',
      domain: {
        id: 'd1',
        origin: 'https://www.winery.com',
        registrableDomain: 'winery.com',
        status: 'PENDING',
        verificationToken: 'a-nonce',
        createdAt: new Date('2026-09-25T09:00:00.000Z'),
      },
    });
  });

  it('reports an empty result as taken, which is how a conflict arrives', async () => {
    const { result } = adding([]);

    await expect(result).resolves.toEqual({ outcome: 'taken' });
  });
});

describe('the plan cap', () => {
  it('locks the winery own row before counting anything', async () => {
    /*
     * **The set being counted is often empty, and there is no way to lock rows
     * that do not exist** — so the thing that serialises two simultaneous adds
     * is the one row that is always there. Whether it *actually* serialises
     * them is `domains.integration.test.ts`; that it is asked for first, and
     * with `FOR UPDATE`, is here.
     */
    const { statements, result } = adding([raw]);

    await result;

    expect(text(statements[LOCK])).toMatch(/SELECT 1 FROM tenants FOR UPDATE/u);
    expect(text(statements[COUNT])).toMatch(/count\(\*\)/u);
  });

  it('refuses once the winery holds its allowance', async () => {
    const { result } = adding([raw], 2, 2);

    await expect(result).resolves.toEqual({ outcome: 'at-cap', held: 2 });
  });

  it('refuses if it somehow holds more than its allowance', async () => {
    /* A plan downgrade leaves a winery over its new cap, and `=== cap` would
     * let it add another. */
    const { result } = adding([raw], 5, 2);

    await expect(result).resolves.toMatchObject({ outcome: 'at-cap' });
  });

  it('allows the last one under the allowance', async () => {
    const { result } = adding([raw], 1, 2);

    await expect(result).resolves.toMatchObject({ outcome: 'created' });
  });

  it('writes nothing at all once refused', async () => {
    const { statements, result } = adding([raw], 2, 2);

    await result;

    /* The lock and the count, and no insert. */
    expect(statements).toHaveLength(2);
  });

  it('counts pending claims as well as verified ones', async () => {
    /* A cap that ignored pending rows would let a seller hold any number of
     * origins by never finishing verification — and a pending row holds the
     * origin against every other winery (§3.2). */
    const { statements, result } = adding([raw]);

    await result;

    expect(text(statements[COUNT])).not.toMatch(/status/u);
  });
});

describe('counting domains', () => {
  it('reads the count as a number, not a bigint string', async () => {
    const { tx } = capturing([{ held: 3 }]);

    await expect(countDomains(tx)).resolves.toBe(3);
  });

  it('is nought when the query answers nothing at all', async () => {
    const { tx } = capturing([]);

    await expect(countDomains(tx)).resolves.toBe(0);
  });
});

describe('reading the plan', () => {
  it('gives back the plan the winery is on', async () => {
    const { tx } = capturing([{ plan: 'ECOMMERCE' }]);

    await expect(readTenantPlan(tx)).resolves.toBe('ECOMMERCE');
  });

  it('gives back nothing for a winery between signup and checkout', async () => {
    const { tx } = capturing([{ plan: null }]);

    await expect(readTenantPlan(tx)).resolves.toBeNull();
  });

  it('names no tenant, because the policy is what scopes it', async () => {
    const { statements, tx } = capturing([{ plan: 'CANTINA' }]);

    await readTenantPlan(tx);

    expect(text(statements[0])).not.toMatch(/WHERE/u);
  });
});

describe('reading a domain by origin', () => {
  it('names no tenant, because the policy is what scopes it', () => {
    const { statements, tx } = capturing([raw]);

    void readDomainByOrigin(tx, 'https://www.winery.com');

    expect(text(statements[0])).toMatch(/WHERE origin =/u);
    expect(text(statements[0])).not.toMatch(/tenant_id/u);
  });

  it('gives back the row when there is one', async () => {
    const { tx } = capturing([raw]);

    await expect(readDomainByOrigin(tx, 'https://www.winery.com')).resolves.toMatchObject({
      id: 'd1',
      registrableDomain: 'winery.com',
    });
  });

  it('gives back nothing when there is not', async () => {
    const { tx } = capturing([]);

    await expect(readDomainByOrigin(tx, 'https://www.winery.com')).resolves.toBeUndefined();
  });

  it('carries a null token through rather than inventing one', async () => {
    const { tx } = capturing([{ ...raw, verification_token: null, status: 'VERIFIED' }]);

    await expect(readDomainByOrigin(tx, 'https://www.winery.com')).resolves.toMatchObject({
      status: 'VERIFIED',
      verificationToken: null,
    });
  });
});

describe('listing a winery domains', () => {
  it('maps every row', async () => {
    const { tx } = capturing([raw, { ...raw, id: 'd2', origin: 'https://shop.winery.com' }]);

    await expect(readDomains(tx)).resolves.toMatchObject([
      { id: 'd1', origin: 'https://www.winery.com' },
      { id: 'd2', origin: 'https://shop.winery.com' },
    ]);
  });

  it('is empty when the winery has none', async () => {
    const { tx } = capturing([]);

    await expect(readDomains(tx)).resolves.toEqual([]);
  });

  it('orders by creation, so the screen does not reshuffle on every load', () => {
    const { statements, tx } = capturing([raw]);

    void readDomains(tx);

    expect(text(statements[0])).toMatch(/ORDER BY created_at, origin/u);
  });
});

describe('reading a domain by id', () => {
  it('names no tenant, because the policy is what scopes it', async () => {
    /*
     * The absence is what makes §3.5 work: another winery's id and an id that
     * does not exist are the same empty result, so the caller has one answer to
     * give and it is 404. A predicate here would suggest the isolation came
     * from the query.
     */
    const { statements, tx } = capturing([raw]);

    await readDomainById(tx, 'd1');

    expect(text(statements[0])).toMatch(/WHERE id =/u);
    expect(text(statements[0])).not.toMatch(/tenant_id/u);
  });

  it('gives back nothing for an id it cannot see', async () => {
    const { tx } = capturing([]);

    await expect(readDomainById(tx, 'd1')).resolves.toBeUndefined();
  });
});

describe('marking a domain verified', () => {
  const verified = { ...raw, status: 'VERIFIED' as const };

  it('stamps the status, the time and the proof', async () => {
    const { statements, tx } = capturing([verified]);

    await markDomainVerified(tx, 'd1', 'DNS_TXT');

    const sql = text(statements[0]);

    expect(sql).toMatch(/SET status = 'VERIFIED'/u);
    expect(sql).toMatch(/verified_at = now\(\)/u);
    expect(sql).toMatch(/verification_method =/u);
  });

  it('refuses to re-verify, in the statement rather than beside it', async () => {
    /*
     * **The guard is part of the write.** A caller that read the status and then
     * updated has a guard with a bypass, and two verifications arriving together
     * would both pass it — resetting `verified_at` on a domain that was verified
     * weeks ago, which is the one column an incident review reads.
     */
    const { statements, tx } = capturing([verified]);

    await markDomainVerified(tx, 'd1', 'DNS_TXT');

    expect(text(statements[0])).toMatch(/AND status = 'PENDING'/u);
  });

  it('reports nothing when it changed nothing', async () => {
    const { tx } = capturing([]);

    await expect(markDomainVerified(tx, 'd1', 'DNS_TXT')).resolves.toBeUndefined();
  });

  it('gives the updated row back', async () => {
    const { tx } = capturing([verified]);

    await expect(markDomainVerified(tx, 'd1', 'WELL_KNOWN')).resolves.toMatchObject({
      status: 'VERIFIED',
    });
  });
});
