import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, createDbClient, getDb } from '../src/client.js';

// postgres-js connects lazily, so building a client never opens a socket.
// These stay unit tests; the connection itself is proved by the integration
// suite, which is where a fake would prove nothing anyway.
const DSN = 'postgres://user:pass@localhost:5432/db?sslmode=disable';

afterEach(async () => {
  await closeDb();
  delete process.env.DATABASE_URL;
});

describe('createDbClient', () => {
  it('builds an independent client per call', () => {
    const a = createDbClient(DSN);
    const b = createDbClient(DSN);

    expect(a.db).not.toBe(b.db);
    return Promise.all([a.close(), b.close()]);
  });
});

describe('getDb', () => {
  it('fails with an actionable message when DATABASE_URL is unset', () => {
    // Names where the value comes from, so the reader is not left guessing
    // which of deploy, SSM or the local env is wrong.
    expect(() => getDb()).toThrow('/sommelier/<stage>/database/url');
  });

  it('memoises across calls so a warm container reuses one pool', () => {
    process.env.DATABASE_URL = DSN;

    expect(getDb()).toBe(getDb());
  });

  it('builds a fresh client after closeDb', async () => {
    process.env.DATABASE_URL = DSN;
    const first = getDb();

    await closeDb();

    expect(getDb()).not.toBe(first);
  });
});
