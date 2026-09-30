import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/client.js';
import { resolveTenantByKeyAndOrigin } from '../src/widget-resolution.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The allowlist accessor, without a database (P2-07).
 *
 * Which statement it issues, inside which scope, and how each shape of row
 * becomes an outcome. Whether the policies admit exactly those rows is asserted
 * against real Postgres in `widget-resolution.integration.test.ts`.
 */

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const KEY = ['pk', 'test', 'resolution0002'].join('_');
const ORIGIN = 'https://cantina.example';

/** A database whose transaction answers the scope's `set_config`, then `rows`. */
const fakeDb = (rows: unknown[]) => {
  const statements: unknown[] = [];
  let call = 0;

  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    call += 1;
    return Promise.resolve(call === 1 ? [] : rows);
  });

  const tx = { execute } as unknown as DbTransaction;
  const transaction = vi.fn<
    (cb: (tx: DbTransaction) => Promise<unknown>, config?: unknown) => Promise<unknown>
  >((cb) => cb(tx));

  return { db: { transaction } as unknown as Database, statements, transaction };
};

const sqlOf = (statement: unknown): { sql: string; params: unknown[] } => {
  const query = new PgDialect().sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]);
  return { sql: query.sql, params: query.params };
};

const row = (overrides: Record<string, unknown> = {}) => ({
  tenant_id: TENANT,
  usable: true,
  domain_id: 'd0000000-0000-4000-8000-000000000001',
  status: 'ACTIVE',
  trial_ends_at: null,
  plan: 'CANTINA',
  locale: 'it',
  ...overrides,
});

describe('the outcomes', () => {
  it('resolves a usable key from a verified origin to its tenant', async () => {
    const { db } = fakeDb([row()]);

    await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).resolves.toEqual({
      found: true,
      tenantId: TENANT,
      status: 'ACTIVE',
      trialEndsAt: null,
      plan: 'CANTINA',
      locale: 'it',
      turnstile: false,
      originKind: 'production',
    });
  });

  it('carries a trial’s end as a date, whichever form the driver gives it (P5-05a)', async () => {
    const endsAt = new Date('2026-10-14T12:00:00.000Z');

    for (const given of [endsAt, endsAt.toISOString()]) {
      const { db } = fakeDb([row({ status: 'TRIALING', trial_ends_at: given })]);

      await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).resolves.toMatchObject({
        status: 'TRIALING',
        trialEndsAt: endsAt,
      });
    }
  });

  it('resolves the winery’s live development origin, and says so (P4-19b)', async () => {
    const { db, statements } = fakeDb([row({ domain_id: null, development: true })]);

    await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).resolves.toMatchObject({
      found: true,
      originKind: 'development',
    });
    expect(sqlOf(statements[1]).sql).toContain('t.dev_mode_expires_at > now()');
  });

  it('treats a local origin with no live development mode as a mismatch (P4-19b)', async () => {
    const { db } = fakeDb([row({ domain_id: null, development: false, status: null })]);

    await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).resolves.toEqual({
      found: false,
      reason: 'origin_mismatch',
      tenantId: TENANT,
    });
  });

  it('says a staging origin is one, for its lower rate limit (P4-19)', async () => {
    const { db, statements } = fakeDb([row({ kind: 'staging' })]);

    await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).resolves.toMatchObject({
      originKind: 'staging',
    });
    expect(sqlOf(statements[1]).sql).toContain('d.kind');
  });

  it("carries the winery's Turnstile flag through (P4-14)", async () => {
    const { db } = fakeDb([row({ turnstile_enabled: true })]);

    await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).resolves.toMatchObject({
      turnstile: true,
    });
  });

  it('carries a null plan through, for a tenant with no subscription yet', async () => {
    const { db } = fakeDb([row({ plan: null, status: 'TRIALING' })]);

    await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).resolves.toMatchObject({
      found: true,
      plan: null,
      status: 'TRIALING',
    });
  });

  it('reports a key that matches no row as unknown', async () => {
    const { db } = fakeDb([]);

    await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).resolves.toEqual({
      found: false,
      reason: 'unknown_key',
    });
  });

  it('reports a revoked key past its grace window as unknown, not as a mismatch', async () => {
    // Rotation is how a leaked key is retired; a retired key is no theft signal.
    const { db } = fakeDb([row({ usable: false })]);

    await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).resolves.toEqual({
      found: false,
      reason: 'unknown_key',
    });
  });

  it("reports a real key from an unverified origin as a mismatch, with the key's tenant", async () => {
    const { db } = fakeDb([row({ domain_id: null, status: null, plan: null, locale: null })]);

    await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).resolves.toEqual({
      found: false,
      reason: 'origin_mismatch',
      tenantId: TENANT,
    });
  });

  it('throws, rather than refusing, when a verified domain has no visible tenant', async () => {
    // The policies and the query would disagree; a refusal would hide the bug.
    const { db } = fakeDb([row({ status: null, locale: null })]);

    await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).rejects.toThrow(/migration 0042/);
  });

  it('throws when a verified tenant comes back with no locale', async () => {
    const { db } = fakeDb([row({ locale: null })]);

    await expect(resolveTenantByKeyAndOrigin(KEY, ORIGIN, db)).rejects.toThrow(/disagree/);
  });
});

describe('the statement', () => {
  it('runs inside the read-only widget scope, set to this key and origin', async () => {
    const { db, statements, transaction } = fakeDb([row()]);

    await resolveTenantByKeyAndOrigin(KEY, ORIGIN, db);

    expect(transaction.mock.calls[0]?.[1]).toEqual({ accessMode: 'read only' });
    expect(sqlOf(statements[0]).params).toEqual([
      'app.widget_key',
      KEY,
      'app.widget_origin',
      ORIGIN,
    ]);
  });

  it('matches only a verified domain and a key that is still usable', async () => {
    const { db, statements } = fakeDb([row()]);

    await resolveTenantByKeyAndOrigin(KEY, ORIGIN, db);

    const { sql } = sqlOf(statements[1]);
    expect(sql).toContain("d.status = 'VERIFIED'");
    expect(sql).toContain('k.revoked_at IS NULL OR k.grace_until > now()');
    expect(sql).toContain('LEFT JOIN tenant_domains d');
  });

  it('binds the key and the origin as parameters, compared exactly', async () => {
    const { db, statements } = fakeDb([row()]);
    const hostile = "https://x.example' OR '1'='1";

    await resolveTenantByKeyAndOrigin(KEY, hostile, db);

    const { sql, params } = sqlOf(statements[1]);
    expect(sql).not.toContain("'1'='1");
    expect(sql).not.toMatch(/\bLIKE\b|~|similar to/i);
    /* The origin twice: the verified domain, and the development origin (P4-19b). */
    expect(params).toEqual([hostile, hostile, KEY]);
  });
});
