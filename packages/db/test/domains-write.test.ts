import { describe, expect, it, vi } from 'vitest';

import { insertDomain, readDomainByOrigin, readDomains } from '../src/domains-write.js';
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

describe('inserting a domain', () => {
  it('takes its tenant from the GUC, never from an argument', () => {
    /*
     * The statement names no tenant (P0-19, P0-48). A caller outside
     * `withTenant` therefore writes nothing at all, rather than writing a row
     * attributed to whatever it happened to pass.
     */
    const { statements, tx } = capturing([raw]);

    void insertDomain(tx, {
      origin: 'https://www.winery.com',
      registrableDomain: 'winery.com',
      verificationToken: 'a-nonce',
    });

    expect(text(statements[0])).toMatch(/current_setting\('app\.tenant_id', true\)/u);
    expect(text(statements[0])).not.toMatch(/tenant_id\s*=/u);
  });

  it('asks the unique index rather than raising on it', () => {
    /* `DO NOTHING`, because a raised 23505 aborts the transaction the audit row
     * has to share (P0-53). `DO UPDATE` would hand a returning seller a new
     * nonce for a DNS record they have already published. */
    const { statements, tx } = capturing([raw]);

    void insertDomain(tx, {
      origin: 'https://www.winery.com',
      registrableDomain: 'winery.com',
      verificationToken: 'a-nonce',
    });

    expect(text(statements[0])).toMatch(/ON CONFLICT \(origin\) DO NOTHING/u);
    expect(text(statements[0])).not.toMatch(/DO UPDATE/u);
  });

  it('maps the row back into the shape the application uses', async () => {
    const { tx } = capturing([raw]);

    await expect(
      insertDomain(tx, {
        origin: 'https://www.winery.com',
        registrableDomain: 'winery.com',
        verificationToken: 'a-nonce',
      }),
    ).resolves.toEqual({
      id: 'd1',
      origin: 'https://www.winery.com',
      registrableDomain: 'winery.com',
      status: 'PENDING',
      verificationToken: 'a-nonce',
      createdAt: new Date('2026-09-25T09:00:00.000Z'),
    });
  });

  it('reports an empty result as nothing, which is how a conflict arrives', async () => {
    const { tx } = capturing([]);

    await expect(
      insertDomain(tx, {
        origin: 'https://www.winery.com',
        registrableDomain: 'winery.com',
        verificationToken: 'a-nonce',
      }),
    ).resolves.toBeUndefined();
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
