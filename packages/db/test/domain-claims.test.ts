import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import {
  ClaimChangedError,
  insertClaim,
  markClaimProven,
  readClaimById,
  reissueClaimVerification,
} from '../src/domain-claims.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * The claimant's statements, without a database (P4-18).
 *
 * Shapes and branches. **Every statement names the claimant's tenant as well
 * as relying on the policy**, and that is the property worth a test here: the
 * policy's other half admits the holder a notice was served on, and a holder
 * must never be able to prove, reissue or read a claim through the claimant's
 * routes. Whether the policy itself holds is `with-domain-claim.integration`'s.
 */

const capturing = (...responses: unknown[][]) => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve(responses.shift() ?? []);
  });

  return { statements, tx: { execute } as unknown as DbTransaction };
};

const params = (statement: unknown): unknown[] =>
  new PgDialect().sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]).params;

const raw = {
  id: 'c1',
  origin: 'https://www.winery.com',
  registrable_domain: 'winery.com',
  status: 'PENDING',
  verification_token: 'a-nonce',
  verification_expires_at: new Date('2026-10-06T09:00:00.000Z'),
  transfer_at: null,
  created_at: new Date('2026-09-29T09:00:00.000Z'),
};

const claim = {
  id: 'c1',
  origin: 'https://www.winery.com',
  registrableDomain: 'winery.com',
  status: 'PENDING',
  verificationToken: 'a-nonce',
  verificationExpiresAt: new Date('2026-10-06T09:00:00.000Z'),
  transferAt: null,
  createdAt: new Date('2026-09-29T09:00:00.000Z'),
};

const OWN_TENANT = "tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid";

const NEW = {
  origin: 'https://www.winery.com',
  registrableDomain: 'winery.com',
  verificationToken: 'a-nonce',
};

describe('opening a claim', () => {
  it('opens one, taking the claimant from the GUC', async () => {
    const { tx, statements } = capturing([raw]);

    await expect(insertClaim(tx, NEW)).resolves.toEqual({ created: true, claim });
    expect(text(statements[0])).toContain(
      "nullif(current_setting('app.tenant_id', true), '')::uuid",
    );
    expect(text(statements[0])).toContain(
      "ON CONFLICT (tenant_id, origin) WHERE status IN ('PENDING', 'PROVEN', 'NOTICE') DO NOTHING",
    );
    expect(text(statements[0])).not.toContain('incumbent_tenant_id');
    expect(params(statements[0])).toEqual(['https://www.winery.com', 'winery.com', 'a-nonce']);
  });

  it('hands back the claim already open, with the nonce already published', async () => {
    const { tx, statements } = capturing([], [raw]);

    await expect(insertClaim(tx, NEW)).resolves.toEqual({ created: false, claim });
    expect(text(statements[1])).toContain(OWN_TENANT);
    expect(text(statements[1])).toContain("status IN ('PENDING', 'PROVEN', 'NOTICE')");
  });

  it('asks to be repeated when the open claim closed in between', async () => {
    const { tx } = capturing([], []);

    await expect(insertClaim(tx, NEW)).rejects.toBeInstanceOf(ClaimChangedError);
  });
});

describe('the claimant’s reads and writes', () => {
  it('reads a claim by id as the claimant, never as its holder', async () => {
    const { tx, statements } = capturing([raw]);

    await expect(readClaimById(tx, 'c1')).resolves.toEqual(claim);
    expect(text(statements[0])).toContain(OWN_TENANT);
    expect(text(statements[0])).not.toContain('incumbent_tenant_id');
  });

  it('answers nothing for an id it cannot see', async () => {
    const { tx } = capturing([]);

    await expect(readClaimById(tx, 'c1')).resolves.toBeUndefined();
  });

  it('proves a claim only while it is pending and carries the nonce that was checked', async () => {
    const { tx, statements } = capturing([{ ...raw, status: 'PROVEN', verification_token: null }]);

    await expect(markClaimProven(tx, 'c1', 'a-nonce')).resolves.toMatchObject({
      status: 'PROVEN',
      verificationToken: null,
    });
    expect(text(statements[0])).toContain(OWN_TENANT);
    expect(text(statements[0])).toContain("AND status = 'PENDING'");
    expect(text(statements[0])).toContain('AND verification_token =');
    expect(text(statements[0])).toContain('verification_token = null');
    expect(params(statements[0])).toEqual(['c1', 'a-nonce']);
  });

  it('reissues a nonce only on a pending claim of the claimant’s own', async () => {
    const { tx, statements } = capturing([]);

    await expect(reissueClaimVerification(tx, 'c1', 'fresh')).resolves.toBeUndefined();
    expect(text(statements[0])).toContain(OWN_TENANT);
    expect(text(statements[0])).toContain("AND status = 'PENDING'");
    expect(params(statements[0])).toEqual(['fresh', 'c1']);
  });
});
