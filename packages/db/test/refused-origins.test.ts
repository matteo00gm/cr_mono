import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { readRefusedOrigins } from '../src/refused-origins.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * The refused sites, without a database (P6-05). What they count is real SQL
 * and lives in `refused-origins.integration.test.ts`.
 */

const fakeTx = (rows: unknown[] = []) => {
  const execute = vi.fn<(statement: SQL) => Promise<unknown[]>>(() => Promise.resolve(rows));
  return { execute, tx: { execute } as unknown as DbTransaction };
};

const QUERY = {
  start: new Date('2026-09-01T00:00:00.000Z'),
  end: new Date('2026-09-08T00:00:00.000Z'),
  limit: 50,
};

const statementOf = (fake: ReturnType<typeof fakeTx>): SQL => {
  const statement = fake.execute.mock.calls[0]?.[0];
  if (statement === undefined) throw new Error('no statement issued');
  return statement;
};

describe('readRefusedOrigins', () => {
  it('reads each row back, and a domain status it does not know as none', async () => {
    const fake = fakeTx([
      {
        origin: 'https://shop.example',
        attempts: '5',
        sources: 3,
        last_seen_at: '2026-09-03 12:00:00+00',
        domain_status: 'PENDING',
      },
      {
        origin: 'null',
        attempts: 1,
        sources: 1,
        last_seen_at: '2026-09-04 12:00:00+00',
        domain_status: null,
      },
      {
        origin: 'https://other.example',
        attempts: 1,
        sources: 1,
        last_seen_at: '2026-09-04 12:00:00+00',
        domain_status: 'SOMETHING_ELSE',
      },
    ]);

    expect(await readRefusedOrigins(fake.tx, QUERY)).toEqual([
      {
        origin: 'https://shop.example',
        attempts: 5,
        sources: 3,
        lastSeenAt: new Date('2026-09-03T12:00:00.000Z'),
        domainStatus: 'PENDING',
      },
      {
        origin: 'null',
        attempts: 1,
        sources: 1,
        lastSeenAt: new Date('2026-09-04T12:00:00.000Z'),
        domainStatus: null,
      },
      {
        origin: 'https://other.example',
        attempts: 1,
        sources: 1,
        lastSeenAt: new Date('2026-09-04T12:00:00.000Z'),
        domainStatus: null,
      },
    ]);
  });

  it("reads only refusals for an origin, in the scope's tenant", async () => {
    const fake = fakeTx();

    await readRefusedOrigins(fake.tx, QUERY);

    const said = text(statementOf(fake));

    expect(said).toContain("e.type = 'UNAUTHORIZED_ORIGIN'");
    expect(said).toContain(
      "e.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid",
    );
  });

  it('binds the range and the limit it is given', async () => {
    const fake = fakeTx();

    await readRefusedOrigins(fake.tx, { ...QUERY, limit: 7 });

    expect(new PgDialect().sqlToQuery(statementOf(fake)).params).toEqual(
      expect.arrayContaining([QUERY.start.toISOString(), QUERY.end.toISOString(), 7]),
    );
  });
});
