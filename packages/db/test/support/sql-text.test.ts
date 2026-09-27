import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { text } from './sql-text.js';

/** The helper the statement assertions rest on — so it gets its own. */
describe('the SQL text of a statement', () => {
  it('reads a flat statement', () => {
    expect(text(sql`SELECT 1 FROM tenants`)).toContain('SELECT 1 FROM tenants');
  });

  it('reads into fragments, which is what the one-level copies could not', () => {
    const columns = sql`id, secret_key_hash`;
    const statement = sql`SELECT ${columns} FROM widget_keys`;

    expect(text(statement)).toContain('secret_key_hash');
  });

  it('reads fragments inside fragments', () => {
    const inner = sql`tenant_id = 1`;
    const middle = sql`WHERE ${inner}`;

    expect(text(sql`SELECT * FROM t ${middle}`)).toContain('tenant_id = 1');
  });

  it('leaves bound values out, since they are not SQL', () => {
    expect(text(sql`SELECT * FROM t WHERE id = ${'a-secret-looking-value'}`)).not.toContain(
      'a-secret-looking-value',
    );
  });

  it('reads nothing from something that is not a statement', () => {
    expect(text(undefined)).toBe('');
    expect(text({})).toBe('');
  });
});
