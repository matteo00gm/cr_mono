import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { conversations, messageRole, messages } from '../../src/schema/conversations.js';

/**
 * Shape assertions for `conversations` and `messages` (P0-28).
 */

const conversationConfig = getTableConfig(conversations);
const messageConfig = getTableConfig(messages);

describe('conversations schema', () => {
  it('constrains visitor_hash to a SHA-256 digest', () => {
    // The constraint is what turns "never store a raw IP" from a rule someone
    // has to remember into something the database will not accept.
    expect(conversationConfig.checks.map((c) => c.name)).toContain(
      'conversations_visitor_hash_is_sha256',
    );
  });

  it('cascades from tenants.id', () => {
    // The P7-07 retention purge and a GDPR erasure both rely on deleting a
    // tenant taking its whole history with it.
    const [foreignKey] = conversationConfig.foreignKeys;
    const reference = foreignKey?.reference();

    expect(getTableConfig(reference?.foreignTable ?? conversations).name).toBe('tenants');
    expect(foreignKey?.onDelete).toBe('cascade');
  });

  it('indexes the scan the purge job and analytics both make', () => {
    expect(conversationConfig.indexes.map((i) => i.config.name)).toContain(
      'conversations_tenant_started_idx',
    );
  });
});

describe('messages schema', () => {
  it('declares the three message roles', () => {
    expect(messageRole.enumValues).toEqual(['USER', 'ASSISTANT', 'SYSTEM']);
  });

  it('records retrieved product ids without a foreign key', () => {
    // Deliberate. This is a record of what was shown at the time and has to
    // survive the product being archived or deleted — a cascade would erase the
    // evidence along with the product. Postgres cannot express an FK array
    // anyway, so the only risk is someone "fixing" it into a join table with
    // cascade semantics.
    const column = messageConfig.columns.find((c) => c.name === 'retrieved_product_ids');

    expect(column?.getSQLType()).toBe('uuid[]');
    expect(
      messageConfig.foreignKeys
        .map((fk) => getTableConfig(fk.reference().foreignTable).name)
        .sort(),
    ).toEqual(['conversations', 'tenants']);
  });

  it('cascades from its conversation', () => {
    const conversationFk = messageConfig.foreignKeys.find(
      (fk) => getTableConfig(fk.reference().foreignTable).name === 'conversations',
    );

    expect(conversationFk?.onDelete).toBe('cascade');
  });
});
