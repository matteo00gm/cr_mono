import { describe, expect, it, vi } from 'vitest';

import {
  insertKeys,
  readActiveKeys,
  readKeyInGrace,
  replaceSecretKey,
  rotatePublicKey,
} from '../src/widget-keys-write.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The key statements, without a database (P4-09).
 *
 * Shapes only. That nothing but the hash reaches the row, and that rotation
 * really removes the old hash, are asserted against real Postgres in
 * `widget-keys.integration.test.ts`. What is worth asserting here is the part
 * a fake *can* see: which columns each statement names.
 */

const capturing = (rows: unknown[] = []) => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);

    return Promise.resolve(rows);
  });

  return { statements, tx: { execute } as unknown as DbTransaction };
};

/**
 * The literal SQL of a statement, with its bound values elided.
 *
 * **Recursive, and it has to be.** A fragment like `VISIBLE` is embedded as a
 * nested `sql` object rather than as a string chunk, so a flat walk skips it —
 * and the first version of this helper did, which meant every assertion about
 * which columns a statement selects was checking nothing. The mutation that
 * added `secret_key_hash` to the selected columns survived that version.
 */
const text = (statement: unknown): string =>
  ((statement as { queryChunks?: unknown[] }).queryChunks ?? [])
    .flatMap((chunk): string[] => {
      if (typeof chunk !== 'object' || chunk === null) return [];
      if (Array.isArray((chunk as { value?: unknown[] }).value)) {
        return (chunk as { value: unknown[] }).value as string[];
      }
      if (Array.isArray((chunk as { queryChunks?: unknown[] }).queryChunks)) return [text(chunk)];

      return [];
    })
    .join(' ');

const raw = {
  id: 'k1',
  public_key: 'pk_live_x',
  secret_key_prefix: 'sk_live_Ab3x',
  secret_key_last4: 'Wq7Z',
  created_at: '2026-09-26 09:00:00.000000+00',
  updated_at: '2026-09-26 09:30:00.000000+00',
};

const hashed = {
  secretKeyHash: 'a'.repeat(64),
  secretKeyPrefix: 'sk_live_Ab3x',
  secretKeyLast4: 'Wq7Z',
};

describe('reading the active keys', () => {
  it('never selects the hash', async () => {
    /*
     * **The property this module rests on.** A hash of a key can be replayed
     * against anything that trusts a hash, so it has no business leaving the
     * database — and the simplest way to be sure it never does is to never
     * select it.
     */
    const { statements, tx } = capturing([raw]);

    await readActiveKeys(tx);

    expect(text(statements[0])).not.toMatch(/secret_key_hash|\*/u);
  });

  it('reads only the active key, not one in its grace window', async () => {
    const { statements, tx } = capturing([raw]);

    await readActiveKeys(tx);

    expect(text(statements[0])).toMatch(/WHERE revoked_at IS NULL/u);
  });

  it('names no tenant, because the policy is what scopes it', async () => {
    const { statements, tx } = capturing([raw]);

    await readActiveKeys(tx);

    expect(text(statements[0])).not.toMatch(/tenant_id/u);
  });

  it('maps the row, turning timestamp strings into Dates', async () => {
    const { tx } = capturing([raw]);

    await expect(readActiveKeys(tx)).resolves.toEqual({
      id: 'k1',
      publicKey: 'pk_live_x',
      secretKeyPrefix: 'sk_live_Ab3x',
      secretKeyLast4: 'Wq7Z',
      createdAt: new Date('2026-09-26T09:00:00.000Z'),
      updatedAt: new Date('2026-09-26T09:30:00.000Z'),
    });
  });

  it('gives back nothing for a winery with no keys', async () => {
    const { tx } = capturing([]);

    await expect(readActiveKeys(tx)).resolves.toBeUndefined();
  });
});

describe('issuing keys', () => {
  it('takes its tenant from the GUC, never from an argument', async () => {
    const { statements, tx } = capturing([raw]);

    await insertKeys(tx, { publicKey: 'pk_live_x', ...hashed });

    expect(text(statements[0])).toMatch(/current_setting\('app\.tenant_id', true\)/u);
  });

  it('yields rather than raising when a pair already exists', async () => {
    /* The partial unique index decides, and `DO NOTHING` keeps the refusal
     * from aborting the transaction the audit row shares. */
    const { statements, tx } = capturing([]);

    await expect(insertKeys(tx, { publicKey: 'pk_live_x', ...hashed })).resolves.toBeUndefined();
    expect(text(statements[0])).toMatch(
      /ON CONFLICT \(tenant_id\) WHERE revoked_at IS NULL DO NOTHING/u,
    );
  });

  it('hands back the visible columns only', async () => {
    const { statements, tx } = capturing([raw]);

    await insertKeys(tx, { publicKey: 'pk_live_x', ...hashed });

    const returning = text(statements[0]).split('RETURNING')[1] ?? '';

    expect(returning).not.toMatch(/secret_key_hash/u);
  });
});

describe('rotating the secret', () => {
  it('updates the active row in place rather than inserting a new one', async () => {
    /* A new row would mean a new public key — rotating one the seller did not
     * ask to rotate, and breaking every page it is installed on. */
    const { statements, tx } = capturing([raw]);

    await replaceSecretKey(tx, hashed);

    const sql = text(statements[0]);

    expect(sql).toMatch(/^\s*UPDATE widget_keys/u);
    expect(sql).not.toMatch(/INSERT|public_key =/u);
  });

  it('touches only the active key', async () => {
    const { statements, tx } = capturing([raw]);

    await replaceSecretKey(tx, hashed);

    expect(text(statements[0])).toMatch(/WHERE revoked_at IS NULL/u);
  });

  it('replaces the hash and the hint together', async () => {
    const { statements, tx } = capturing([raw]);

    await replaceSecretKey(tx, hashed);

    const sql = text(statements[0]);

    expect(sql).toMatch(/secret_key_hash =/u);
    expect(sql).toMatch(/secret_key_prefix =/u);
    expect(sql).toMatch(/secret_key_last4 =/u);
  });

  it('gives back nothing when there was nothing to rotate', async () => {
    const { tx } = capturing([]);

    await expect(replaceSecretKey(tx, hashed)).resolves.toBeUndefined();
  });
});

describe('rotating the public key (P4-08)', () => {
  /** A fake that answers each statement in turn. */
  const sequence = (...responses: unknown[][]) => {
    const statements: unknown[] = [];
    let call = 0;
    const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
      statements.push(statement);

      const rows = responses[call] ?? [];

      call += 1;

      return Promise.resolve(rows);
    });

    return { statements, tx: { execute } as unknown as DbTransaction };
  };

  const revokedRow = {
    public_key: 'pk_live_old',
    grace_until: '2026-09-27 09:00:00.000000+00',
    secret_key_hash: 'a'.repeat(64),
    secret_key_prefix: 'sk_live_Ab3x',
    secret_key_last4: 'Wq7Z',
  };

  it('locks the winery row before touching any key', async () => {
    const { statements, tx } = sequence([], [], [revokedRow], [raw]);

    await rotatePublicKey(tx, 'pk_live_new');

    expect(text(statements[0])).toMatch(/SELECT 1 FROM tenants FOR UPDATE/u);
  });

  it('ends any earlier grace before starting a new one', async () => {
    /* At most one old key is live. A seller rotates because they think a key
     * leaked, and rotating again must not leave the first one working. */
    const { statements, tx } = sequence([], [], [revokedRow], [raw]);

    await rotatePublicKey(tx, 'pk_live_new');

    const sql = text(statements[1]);

    expect(sql).toMatch(/SET grace_until = now\(\)/u);
    expect(sql).toMatch(/WHERE revoked_at IS NOT NULL AND grace_until > now\(\)/u);
  });

  it('revokes the active key with a day of grace, before inserting', async () => {
    /* Before, because the partial unique index allows one active key per
     * tenant and checks it per statement. */
    const { statements, tx } = sequence([], [], [revokedRow], [raw]);

    await rotatePublicKey(tx, 'pk_live_new');

    const sql = text(statements[2]);

    expect(sql).toMatch(/SET revoked_at = now\(\), grace_until = now\(\) \+/u);
    expect(sql).toMatch(/interval '24 hours'/u);
    expect(sql).toMatch(/WHERE revoked_at IS NULL/u);
    expect(text(statements[3])).toMatch(/INSERT INTO widget_keys/u);
  });

  it('carries the secret across from the row it revoked', async () => {
    /* Rotating the public key must not rotate a secret the seller did not ask
     * to change. The hash comes from the revoked row, not from the caller. */
    const { statements, tx } = sequence([], [], [revokedRow], [raw]);

    await rotatePublicKey(tx, 'pk_live_new');

    const values = (statements[3] as { queryChunks: unknown[] }).queryChunks.filter(
      (chunk) => typeof chunk === 'string',
    );

    expect(values).toContain('a'.repeat(64));
    expect(values).toContain('pk_live_new');
  });

  it('takes the new row tenant from the GUC, like every other write', async () => {
    const { statements, tx } = sequence([], [], [revokedRow], [raw]);

    await rotatePublicKey(tx, 'pk_live_new');

    expect(text(statements[3])).toMatch(/current_setting\('app\.tenant_id', true\)/u);
  });

  it('reports the new key and the old one with its deadline', async () => {
    const { tx } = sequence([], [], [revokedRow], [raw]);

    await expect(rotatePublicKey(tx, 'pk_live_new')).resolves.toMatchObject({
      active: { publicKey: 'pk_live_x' },
      previous: { publicKey: 'pk_live_old', graceUntil: new Date('2026-09-27T09:00:00.000Z') },
    });
  });

  it('rotates nothing, and inserts nothing, when there is no active key', async () => {
    const { statements, tx } = sequence([], [], [], [raw]);

    await expect(rotatePublicKey(tx, 'pk_live_new')).resolves.toBeUndefined();
    expect(statements).toHaveLength(3);
  });

  it('stops rather than report a rotation that inserted nothing', async () => {
    /* Impossible under the lock — which is exactly why an empty result means
     * the reasoning has broken, and the honest answer is to stop. */
    const { tx } = sequence([], [], [revokedRow], []);

    await expect(rotatePublicKey(tx, 'pk_live_new')).rejects.toThrow(/not inserted/u);
  });
});

describe('the key in its grace window (P4-08)', () => {
  it('is read with the database clock, so it agrees with resolution', async () => {
    const { statements, tx } = capturing([
      { public_key: 'pk_live_old', grace_until: '2026-09-27 09:00:00.000000+00' },
    ]);

    await expect(readKeyInGrace(tx)).resolves.toEqual({
      publicKey: 'pk_live_old',
      graceUntil: new Date('2026-09-27T09:00:00.000Z'),
    });
    expect(text(statements[0])).toMatch(/grace_until > now\(\)/u);
  });

  it('is nothing when no key is in grace', async () => {
    const { tx } = capturing([]);

    await expect(readKeyInGrace(tx)).resolves.toBeUndefined();
  });
});
