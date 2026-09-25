import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { insertDomain, readDomainByOrigin, readDomains } from '../src/domains-write.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Adding a domain, against real Postgres (P4-01, §3.2).
 *
 * **Three properties live here and nowhere else**, and each is the reason the
 * port is shaped the way it is:
 *
 * 1. **An origin another winery holds is invisible to a `SELECT`.** RLS hides
 *    the row, so "is this taken?" is a question the application genuinely
 *    cannot ask — which is why the answer comes from attempting the insert.
 * 2. **The unique index is global, not per tenant.** It covers `PENDING` rows
 *    as well as verified ones, so an unverified claim holds the origin and two
 *    wineries cannot race at verification time.
 * 3. **`ON CONFLICT DO NOTHING` leaves the transaction usable.** A raised
 *    `23505` would abort it, taking the audit row with it — which is the whole
 *    reason the statement is written this way rather than wrapped in a `catch`.
 *
 * A unit test with a mocked driver can assert none of them: it would be
 * asserting the mock.
 */

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

/**
 * Seeds the two wineries.
 *
 * Each row goes in **inside `withTenant` for its own id**, because `tenants`
 * carries `WITH CHECK (id = app.tenant_id)` — the row has to satisfy the policy
 * it is creating the context for, which is the shape signup uses in production.
 */
const seed = async (): Promise<void> => {
  for (const [id, name, slug] of [
    [TENANT_A, 'Cantina Rossi', 'cantina-rossi'],
    [TENANT_B, 'Cantina Verdi', 'cantina-verdi'],
  ] as const) {
    await withTenant(
      id,
      (tx) =>
        tx.execute(sql`
          INSERT INTO tenants (id, name, slug)
          VALUES (${id}::uuid, ${name}, ${slug})
          ON CONFLICT DO NOTHING
        `),
      db,
    );
  }
};

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 4 });
  db = client.db;
  await seed();
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

const add = (tenant: string, origin: string, token = 'a-nonce') =>
  withTenant(
    tenant,
    (tx) => insertDomain(tx, { origin, registrableDomain: 'winery.com', verificationToken: token }),
    db,
  );

describe('a domain a winery adds', () => {
  it('is created PENDING, carrying the nonce it was given', async () => {
    const created = await add(TENANT_A, 'https://pending.winery.com');

    expect(created).toMatchObject({
      origin: 'https://pending.winery.com',
      registrableDomain: 'winery.com',
      status: 'PENDING',
      verificationToken: 'a-nonce',
    });
  });

  it('takes its tenant from the context, never from an argument', async () => {
    /*
     * The statement names no tenant at all — the GUC supplies it (P0-19, P0-48).
     * The proof is that the other winery cannot see the row.
     */
    await add(TENANT_A, 'https://scoped.winery.com');

    const mine = await withTenant(
      TENANT_A,
      (tx) => readDomainByOrigin(tx, 'https://scoped.winery.com'),
      db,
    );
    const theirs = await withTenant(
      TENANT_B,
      (tx) => readDomainByOrigin(tx, 'https://scoped.winery.com'),
      db,
    );

    expect(mine?.origin).toBe('https://scoped.winery.com');
    expect(theirs).toBeUndefined();
  });

  it('appears in that winery list and in nobody else', async () => {
    await add(TENANT_A, 'https://listed.winery.com');

    const mine = await withTenant(TENANT_A, (tx) => readDomains(tx), db);
    const theirs = await withTenant(TENANT_B, (tx) => readDomains(tx), db);

    expect(mine.map((domain) => domain.origin)).toContain('https://listed.winery.com');
    expect(theirs.map((domain) => domain.origin)).not.toContain('https://listed.winery.com');
  });
});

describe('an origin another winery already holds', () => {
  it('is invisible to a read, which is why the insert is what asks', async () => {
    /*
     * **The finding that shapes the whole port.** `readDomainByOrigin` answers
     * "no such row" for an origin that certainly exists — RLS is doing exactly
     * what it should — so an implementation that checked first and inserted
     * second would report success and then fail on the constraint.
     */
    await add(TENANT_A, 'https://contested.winery.com');

    const asSeenByB = await withTenant(
      TENANT_B,
      (tx) => readDomainByOrigin(tx, 'https://contested.winery.com'),
      db,
    );

    expect(asSeenByB).toBeUndefined();
  });

  it('is refused, and the refusal is a returned nothing rather than a thrown error', async () => {
    await add(TENANT_A, 'https://taken.winery.com');

    const attempt = await add(TENANT_B, 'https://taken.winery.com');

    expect(attempt).toBeUndefined();
  });

  it('leaves the transaction usable, which is what the audit row depends on', async () => {
    /*
     * **The reason it is `ON CONFLICT DO NOTHING` and not a caught `23505`.**
     * A raised constraint violation aborts the transaction: every statement
     * after it fails with `25P02`, including the audit write that records the
     * refusal (P0-53). Here the write after the refusal succeeds.
     */
    await add(TENANT_A, 'https://usable.winery.com');

    const after = await withTenant(
      TENANT_B,
      async (tx) => {
        const refused = await insertDomain(tx, {
          origin: 'https://usable.winery.com',
          registrableDomain: 'winery.com',
          verificationToken: 'b-nonce',
        });

        /* Any statement at all — if the transaction were aborted this throws. */
        const rows = await tx.execute(sql`SELECT 1 AS ok`);

        return { refused, ok: [...rows].length };
      },
      db,
    );

    expect(after.refused).toBeUndefined();
    expect(after.ok).toBe(1);
  });

  it('is held by a PENDING claim just as firmly as by a verified one', async () => {
    /*
     * Scoping the constraint to verified rows would let two wineries hold
     * competing claims and race at verification — which moves the conflict from
     * "this insert fails now" to "somebody loses a domain they have already
     * built a widget against".
     */
    const claimed = await add(TENANT_A, 'https://unverified.winery.com');

    expect(claimed?.status).toBe('PENDING');
    await expect(add(TENANT_B, 'https://unverified.winery.com')).resolves.toBeUndefined();
  });
});

describe('the same winery adding the same origin twice', () => {
  it('sees its own row on the read, so nothing has to be inserted', async () => {
    await add(TENANT_A, 'https://again.winery.com', 'first-nonce');

    const existing = await withTenant(
      TENANT_A,
      (tx) => readDomainByOrigin(tx, 'https://again.winery.com'),
      db,
    );

    expect(existing?.verificationToken).toBe('first-nonce');
  });

  it('does not overwrite the nonce if the insert is attempted anyway', async () => {
    /* `DO NOTHING`, not `DO UPDATE`: a seller who reloads the screen must not
     * be handed a new token for a DNS record they have already published. */
    await add(TENANT_A, 'https://stable.winery.com', 'original');
    await add(TENANT_A, 'https://stable.winery.com', 'replacement');

    const row = await withTenant(
      TENANT_A,
      (tx) => readDomainByOrigin(tx, 'https://stable.winery.com'),
      db,
    );

    expect(row?.verificationToken).toBe('original');
  });
});

/**
 * Which constraint refused an origin, by name.
 *
 * The name rather than the message, because a message match would also pass for
 * a syntax error in the statement — and that is precisely the failure this
 * would then hide.
 */
const refusedBy = async (origin: string): Promise<string> => {
  try {
    await add(TENANT_A, origin);

    return 'it was accepted';
  } catch (error) {
    const cause = (error as { cause?: { constraint_name?: string } }).cause;

    return cause?.constraint_name ?? (error as Error).message;
  }
};

describe('the CHECK constraint behind the normaliser', () => {
  it('refuses an origin the normaliser would never have produced', async () => {
    /*
     * Defence in depth (P2-05 is the primary control). This is what holds if
     * normalisation is bypassed, refactored, or simply not reached by some
     * future path — and `HTTPS://WINERY.COM` is the interesting shape, because
     * it is the same origin to a browser and a different string to an exact
     * comparison.
     */
    for (const origin of [
      'HTTPS://WINERY.COM',
      'https://trailing.winery.com.',
      'https://winery.com/shop',
      'https://winery.com/',
      'https://-winery.com',
      'https://win_ery.com',
    ]) {
      expect(await refusedBy(origin)).toBe('tenant_domains_origin_format');
    }
  });
});
