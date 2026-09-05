import type { DbTransaction } from '@catalogorosso/db';
import { REDACTED } from '@catalogorosso/security';
import { describe, expect, it, vi } from 'vitest';

import { audit, MissingAuditTenantError } from '../src/audit.js';
import { runWithRequestContext, type RequestContext } from '../src/request-context.js';

/**
 * The audit writer, without a database (P0-53).
 *
 * What is asserted here is the *shape* of the row: which fields come from the
 * request context, and what happens to metadata on the way in. Whether the
 * insert actually rolls back with its transaction is a property of Postgres and
 * is asserted against a real one in `packages/db/test/audit.integration.test.ts`.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

/** Captures the row the writer would have inserted. */
const capturing = () => {
  const statements: unknown[] = [];
  // Held as its own reference rather than reached for as `tx.execute`, which
  // `unbound-method` flags — an unbound method assertion is one refactor away
  // from losing its `this`.
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve([]);
  });
  const tx = { execute } as unknown as DbTransaction;

  return { statements, execute, tx };
};

const inRequest = async <T>(context: Partial<RequestContext>, fn: () => Promise<T>): Promise<T> =>
  runWithRequestContext({ requestId: 'r1', ...context }, fn);

describe('the transaction', () => {
  it('is the caller’s, never one the writer opened', async () => {
    /*
     * The whole design. The audit row has to commit or roll back with the
     * action it describes — an entry for something that did not happen is worse
     * than no entry, because it is a record people will believe. A helper that
     * opened its own connection would produce exactly that on every failure.
     */
    const { tx, execute } = capturing();

    await inRequest({ tenantId: TENANT }, () => audit(tx, { action: 'member.removed' }));

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('the actor', () => {
  it('comes from the request context, not from arguments', async () => {
    /*
     * For the same reason the logger does not take a logger: the one call site
     * nobody threaded an actor into is the one that matters. `audit()` takes
     * only what describes the *action*.
     */
    const { tx, execute, statements } = capturing();

    await inRequest(
      { tenantId: TENANT, userId: 'user_matteo', ip: '203.0.113.7', userAgent: 'Firefox' },
      async () => {
        await audit(tx, { action: 'domain.added', target: 'shop.example' });
      },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    // All four fields reached the statement without the caller naming any.
    const written = JSON.stringify(statements[0]);
    for (const value of [TENANT, 'user_matteo', '203.0.113.7', 'Firefox']) {
      expect(written, value).toContain(value);
    }
  });

  it('refuses to write without a tenant', async () => {
    /*
     * `audit_log.tenant_id` is NOT NULL and RLS checks it, so a row with no
     * tenant cannot be written anyway — but failing here says *why*, at the
     * call site, instead of surfacing as a constraint violation four layers
     * down. It also means the mistake is visible in a unit test rather than
     * only against a real database.
     */
    const { tx } = capturing();

    await expect(
      inRequest({}, () => audit(tx, { action: 'member.removed' })),
    ).rejects.toBeInstanceOf(MissingAuditTenantError);
  });

  it('names the action in that error, so the caller is findable', async () => {
    const { tx } = capturing();

    const error: unknown = await inRequest({}, () =>
      audit(tx, { action: 'billing.plan.changed' }),
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('billing.plan.changed');
  });

  it('refuses outside a request context entirely', async () => {
    // The worker and migrations run outside one. An audit row written there
    // would have no tenant to scope it, which is the same failure.
    const { tx } = capturing();

    await expect(audit(tx, { action: 'member.removed' })).rejects.toBeInstanceOf(
      MissingAuditTenantError,
    );
  });
});

describe('metadata', () => {
  const metadataOf = async (metadata: Record<string, unknown>): Promise<string> => {
    const { tx, statements } = capturing();
    await inRequest({ tenantId: TENANT }, () => audit(tx, { action: 'x', metadata }));

    return JSON.stringify(statements[0]);
  };

  it('is redacted before it is written', async () => {
    /*
     * The reason this matters more here than in a log line. `audit_log` is
     * append-only at the grant level (P0-31), so a secret written into it
     * cannot be taken out again short of dropping the tenant. Callers pass
     * whatever describes the action, and "whatever" is how a reset token ends
     * up permanent.
     */
    const written = await metadataOf({ requestId: 'r1', resetToken: 'a-secret-value' });

    expect(written).toContain(REDACTED);
    expect(written).not.toContain('a-secret-value');
  });

  it('keeps the fields the allowlist permits', async () => {
    // Redaction that removed everything would make the column useless, which is
    // how it ends up being bypassed.
    expect(await metadataOf({ requestId: 'r1', count: 3 })).toContain('r1');
  });

  it('scrubs a secret out of an allowed field too', async () => {
    // An allowed key can still carry a secret — the second layer of P0-56.
    const written = await metadataOf({
      msg: `token ${'sk_' + 'live' + '_' + 'A1b2C3d4'.repeat(4)}`,
    });

    expect(written).not.toContain('A1b2C3d4');
  });
});
