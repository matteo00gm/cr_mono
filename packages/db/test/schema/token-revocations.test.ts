import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { tokenRevocations } from '../../src/schema/token-revocations.js';

/**
 * Shape assertions for `token_revocations` (P0-35).
 *
 * Behaviour is P2-15's job. These pin the shape the sweep and the verify
 * middleware are written against.
 */

const config = getTableConfig(tokenRevocations);
const columns = new Map(config.columns.map((c) => [c.name, c]));

describe('token_revocations schema', () => {
  it('keys on the jti itself', () => {
    expect(columns.get('jti')?.primary).toBe(true);
  });

  it('requires an expiry, so every row is eventually sweepable', () => {
    // The table's size argument rests on this: a row with no expiry could
    // never be swept, and the list would grow without bound.
    expect(columns.get('expires_at')?.notNull).toBe(true);
  });

  it('indexes expires_at for the sweep', () => {
    const index = config.indexes.find((i) => i.config.name === 'token_revocations_expires_at_idx');

    expect(index).toBeDefined();
  });
});
