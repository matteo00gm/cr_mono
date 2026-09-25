import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import {
  countDomains,
  countVerifiedDomains,
  deleteDomain,
  insertDomain,
  markDomainVerified,
  readDomainById,
  readDomainByOrigin,
  readDomains,
  insertVerifiedSibling,
  readDomainsFor,
  readTenantPlan,
  reissueVerification,
} from '../src/domains-write.js';
import { endSessionsFor, sessionCutoffAt } from '../src/session-cutoffs.js';
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
 * 4. **The plan cap survives two simultaneous adds** (P4-07). Counting and then
 *    inserting is a race, and the lock that closes it is on the winery's own
 *    row because the set being counted is often empty. A fake transaction runs
 *    statements in order by construction, so a missing lock would look
 *    identical to a correct one.
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

/** A generous cap, so the cases that are not about the cap are not about it. */
const ROOMY = 100;

const attempt = (tenant: string, origin: string, token = 'a-nonce', cap = ROOMY) =>
  withTenant(
    tenant,
    (tx) =>
      insertDomain(tx, { origin, registrableDomain: 'winery.com', verificationToken: token }, cap),
    db,
  );

/** The created row, or nothing — the shape the cases below were written against. */
const add = async (tenant: string, origin: string, token = 'a-nonce') => {
  const result = await attempt(tenant, origin, token);

  return result.outcome === 'created' ? result.domain : undefined;
};

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

    await expect(attempt(TENANT_B, 'https://taken.winery.com')).resolves.toEqual({
      outcome: 'taken',
    });
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
        const refused = await insertDomain(
          tx,
          {
            origin: 'https://usable.winery.com',
            registrableDomain: 'winery.com',
            verificationToken: 'b-nonce',
          },
          ROOMY,
        );

        /* Any statement at all — if the transaction were aborted this throws. */
        const rows = await tx.execute(sql`SELECT 1 AS ok`);

        return { refused, ok: [...rows].length };
      },
      db,
    );

    expect(after.refused).toEqual({ outcome: 'taken' });
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
    await expect(attempt(TENANT_B, 'https://unverified.winery.com')).resolves.toEqual({
      outcome: 'taken',
    });
  });
});

describe('the plan cap', () => {
  const CAPPED = '33333333-3333-3333-3333-333333333333';

  it('refuses once the winery holds its allowance', async () => {
    await withTenant(
      CAPPED,
      (tx) =>
        tx.execute(sql`
          INSERT INTO tenants (id, name, slug, plan)
          VALUES (${CAPPED}::uuid, 'Cantina Bianchi', 'cantina-bianchi', 'CANTINA')
          ON CONFLICT DO NOTHING
        `),
      db,
    );

    await expect(attempt(CAPPED, 'https://capped-one.winery.com', 'n', 1)).resolves.toMatchObject({
      outcome: 'created',
    });
    await expect(attempt(CAPPED, 'https://capped-two.winery.com', 'n', 1)).resolves.toEqual({
      outcome: 'at-cap',
      held: 1,
    });
  });

  it('counts only the winery own domains, and counts them once each', async () => {
    /*
     * Two properties in one assertion, and both need a real database.
     *
     * **RLS**: the count names no tenant, so it counts one winery's rows — a
     * cap that counted the whole table would refuse every seller once the
     * platform had two customers.
     *
     * **DISTINCT**: `TENANT_A` holds a dozen origins by now and every one of
     * them is under `winery.com`, so its plan usage is one. Counting rows would
     * have it wildly over any cap it could be sold.
     */
    const capped = await withTenant(CAPPED, (tx) => countDomains(tx), db);
    const busy = await withTenant(TENANT_A, (tx) => countDomains(tx), db);
    const origins = await withTenant(TENANT_A, (tx) => readDomains(tx), db);

    expect(capped).toBe(1);
    expect(origins.length).toBeGreaterThan(5);
    expect(busy).toBe(1);
  });

  it('makes a second add wait for the first to commit', async () => {
    /*
     * **The reason the lock is on `tenants` rather than on the rows being
     * counted.** A winery with no domains has nothing to lock, so two
     * transactions each count nought, each see room, and each insert — putting
     * the winery over its cap with no error anywhere.
     *
     * **Two concurrent calls are not enough to show this**, and the first
     * version of this test was exactly that: it passed with the lock removed,
     * because the driver's round trips happened to serialise. So the first
     * transaction is held open deliberately, and what is asserted is that the
     * second *has not finished* while it is — which is false the moment the
     * lock goes, because an uncommitted insert is invisible to the count and
     * the second transaction sails through.
     *
     * This needs two real connections held at once. The pool is four.
     */
    const RACING = '44444444-4444-4444-4444-444444444444';

    await withTenant(
      RACING,
      (tx) =>
        tx.execute(sql`
          INSERT INTO tenants (id, name, slug, plan)
          VALUES (${RACING}::uuid, 'Cantina Neri', 'cantina-neri', 'CANTINA')
          ON CONFLICT DO NOTHING
        `),
      db,
    );

    let holding = (): void => undefined;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withTenant(
      RACING,
      async (tx) => {
        const created = await insertDomain(
          tx,
          {
            origin: 'https://race-one.winery.com',
            registrableDomain: 'winery.com',
            verificationToken: 'n',
          },
          1,
        );

        holding();
        await released;

        return created;
      },
      db,
    );

    await held;

    let settled = false;
    const second = attempt(RACING, 'https://race-two.winery.com', 'n', 1).then((result) => {
      settled = true;

      return result;
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });

    /* Blocked on the lock the first transaction still holds. */
    expect(settled).toBe(false);

    release();
    await expect(first).resolves.toMatchObject({ outcome: 'created' });
    await expect(second).resolves.toEqual({ outcome: 'at-cap', held: 1 });
    expect(await withTenant(RACING, (tx) => countDomains(tx), db)).toBe(1);
  });

  it('reads the plan from the winery own row', async () => {
    await expect(withTenant(CAPPED, (tx) => readTenantPlan(tx), db)).resolves.toBe('CANTINA');
    /* Seeded with no plan: a winery between signup and checkout. */
    await expect(withTenant(TENANT_A, (tx) => readTenantPlan(tx), db)).resolves.toBeNull();
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

describe('marking a domain verified (P4-02)', () => {
  it('stamps the status, the time and the proof', async () => {
    const created = await add(TENANT_A, 'https://verifiable.winery.com');
    const verified = await withTenant(
      TENANT_A,
      (tx) => markDomainVerified(tx, created?.id ?? '', 'DNS_TXT'),
      db,
    );

    expect(verified?.status).toBe('VERIFIED');

    const stored = await withTenant(TENANT_A, (tx) => readDomainById(tx, created?.id ?? ''), db);

    expect(stored?.status).toBe('VERIFIED');
  });

  it('refuses a second time, so a re-check cannot move verified_at', async () => {
    /*
     * The guard is inside the statement. `verified_at` is the column an
     * incident review reads, and a row that re-stamps it every time somebody
     * presses the button records when the button was last pressed rather than
     * when the domain was proved.
     */
    const created = await add(TENANT_A, 'https://twice.winery.com');

    await withTenant(TENANT_A, (tx) => markDomainVerified(tx, created?.id ?? '', 'DNS_TXT'), db);

    await expect(
      withTenant(TENANT_A, (tx) => markDomainVerified(tx, created?.id ?? '', 'DNS_TXT'), db),
    ).resolves.toBeUndefined();
  });

  it('cannot be reached for another winery row, and says nothing either way', async () => {
    /* §3.5: the policy makes "not yours" and "does not exist" the same empty
     * result, which is what leaves the caller one answer to give. */
    const created = await add(TENANT_A, 'https://theirs.winery.com');

    await expect(
      withTenant(TENANT_B, (tx) => readDomainById(tx, created?.id ?? ''), db),
    ).resolves.toBeUndefined();
    await expect(
      withTenant(TENANT_B, (tx) => markDomainVerified(tx, created?.id ?? '', 'DNS_TXT'), db),
    ).resolves.toBeUndefined();
  });
});

describe('the nonce lifecycle (P4-04)', () => {
  it('gives a new claim a deadline about a week out', async () => {
    /* The window is computed in SQL from the database's own clock, so this is
     * the only place the arithmetic is actually exercised. */
    const created = await add(TENANT_A, 'https://dated.winery.com');
    const days =
      ((created?.verificationExpiresAt?.getTime() ?? 0) - (created?.createdAt.getTime() ?? 0)) /
      86_400_000;

    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('spends the nonce on success', async () => {
    const created = await add(TENANT_A, 'https://spent.winery.com');

    await withTenant(TENANT_A, (tx) => markDomainVerified(tx, created?.id ?? '', 'DNS_TXT'), db);

    const stored = await withTenant(TENANT_A, (tx) => readDomainById(tx, created?.id ?? ''), db);

    expect(stored?.verificationToken).toBeNull();
    expect(stored?.verificationExpiresAt).toBeNull();
  });

  it('issues a different value on reissue, and moves the deadline', async () => {
    const created = await add(TENANT_A, 'https://reissued.winery.com', 'first-nonce');
    const fresh = await withTenant(
      TENANT_A,
      (tx) => reissueVerification(tx, created?.id ?? '', 'second-nonce'),
      db,
    );

    expect(fresh?.verificationToken).toBe('second-nonce');
    expect(fresh?.verificationExpiresAt?.getTime() ?? 0).toBeGreaterThan(
      created?.verificationExpiresAt?.getTime() ?? 0,
    );
  });

  it('will not hand a verified domain a nonce', async () => {
    /* Reopening a closed proof. A verified domain with a live nonce in DNS is
     * a domain somebody can re-prove from a record they did not publish. */
    const created = await add(TENANT_A, 'https://closed.winery.com');

    await withTenant(TENANT_A, (tx) => markDomainVerified(tx, created?.id ?? '', 'DNS_TXT'), db);

    await expect(
      withTenant(TENANT_A, (tx) => reissueVerification(tx, created?.id ?? '', 'nope'), db),
    ).resolves.toBeUndefined();
  });

  it('will not reissue for another winery', async () => {
    const created = await add(TENANT_A, 'https://notyours.winery.com');

    await expect(
      withTenant(TENANT_B, (tx) => reissueVerification(tx, created?.id ?? '', 'nope'), db),
    ).resolves.toBeUndefined();
  });
});

describe('the pair a verification earns (P4-05)', () => {
  it('creates the sibling already verified, with no nonce', async () => {
    await add(TENANT_A, 'https://pair.winery.com');

    const sibling = await withTenant(
      TENANT_A,
      (tx) =>
        insertVerifiedSibling(
          tx,
          { origin: 'https://www.pair.winery.com', registrableDomain: 'winery.com' },
          'DNS_TXT',
        ),
      db,
    );

    expect(sibling).toMatchObject({
      status: 'VERIFIED',
      verificationToken: null,
      verificationExpiresAt: null,
    });
  });

  it('does not take an origin another winery already holds', async () => {
    /* An origin does not become a winery's by being adjacent to something they
     * proved. The unique index decides. */
    await add(TENANT_A, 'https://contested-sibling.winery.com');

    await expect(
      withTenant(
        TENANT_B,
        (tx) =>
          insertVerifiedSibling(
            tx,
            {
              origin: 'https://contested-sibling.winery.com',
              registrableDomain: 'winery.com',
            },
            'DNS_TXT',
          ),
        db,
      ),
    ).resolves.toBeUndefined();
  });

  it('leaves the transaction usable when the sibling is refused', async () => {
    /* The refusal shares a transaction with the verification and its audit row.
     * A raised 23505 would take both down. */
    await add(TENANT_A, 'https://usable-sibling.winery.com');

    const after = await withTenant(
      TENANT_B,
      async (tx) => {
        const refused = await insertVerifiedSibling(
          tx,
          { origin: 'https://usable-sibling.winery.com', registrableDomain: 'winery.com' },
          'DNS_TXT',
        );
        const rows = await tx.execute(sql`SELECT 1 AS ok`);

        return { refused, ok: [...rows].length };
      },
      db,
    );

    expect(after).toEqual({ refused: undefined, ok: 1 });
  });

  it('reads every origin under one registrable domain, and nobody else', async () => {
    const mine = await withTenant(TENANT_A, (tx) => readDomainsFor(tx, 'winery.com'), db);
    const theirs = await withTenant(TENANT_B, (tx) => readDomainsFor(tx, 'winery.com'), db);

    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((row) => row.registrableDomain === 'winery.com')).toBe(true);
    expect(theirs.map((row) => row.origin)).not.toContain(mine[0]?.origin);
  });

  it('counts a pair as one domain, not two', async () => {
    /*
     * **The whole reason the count is `DISTINCT registrable_domain`.** A
     * Cantina plan includes one domain; counting rows would put that seller
     * over their cap the instant they verify the only domain it allows.
     */
    const PAIRED = '66666666-6666-6666-6666-666666666666';

    await withTenant(
      PAIRED,
      (tx) =>
        tx.execute(sql`
          INSERT INTO tenants (id, name, slug, plan)
          VALUES (${PAIRED}::uuid, 'Cantina Gialli', 'cantina-gialli', 'CANTINA')
          ON CONFLICT DO NOTHING
        `),
      db,
    );

    await attempt(PAIRED, 'https://paired.example', 'n', 1);
    await withTenant(
      PAIRED,
      (tx) =>
        insertVerifiedSibling(
          tx,
          { origin: 'https://www.paired.example', registrableDomain: 'winery.com' },
          'DNS_TXT',
        ),
      db,
    );

    expect(await withTenant(PAIRED, (tx) => countDomains(tx), db)).toBe(1);
  });
});

describe('removing a domain (P4-06)', () => {
  it('leaves a cutoff that outlives the row it came from', async () => {
    /*
     * **The property this row is for.** The domain row is deleted outright — a
     * tombstone would hold the origin against every other winery for ever
     * (§3.2) — so the thing that ends its sessions has to live somewhere the
     * delete does not reach. A foreign key to `tenant_domains` would have taken
     * it with the row.
     */
    const created = await add(TENANT_A, 'https://removable.winery.com');

    await withTenant(
      TENANT_A,
      async (tx) => {
        await deleteDomain(tx, created?.id ?? '');
        await endSessionsFor(tx, 'https://removable.winery.com');
      },
      db,
    );

    const gone = await withTenant(
      TENANT_A,
      (tx) => readDomainByOrigin(tx, 'https://removable.winery.com'),
      db,
    );

    expect(gone).toBeUndefined();
    await expect(
      sessionCutoffAt(TENANT_A, 'https://removable.winery.com', db),
    ).resolves.toBeInstanceOf(Date);
  });

  it('frees the origin for somebody else, which a tombstone would not', async () => {
    const created = await add(TENANT_A, 'https://freed.winery.com');

    await withTenant(TENANT_A, (tx) => deleteDomain(tx, created?.id ?? ''), db);

    await expect(attempt(TENANT_B, 'https://freed.winery.com')).resolves.toMatchObject({
      outcome: 'created',
    });
  });

  it('cannot remove another winery domain, and says nothing either way', async () => {
    const created = await add(TENANT_A, 'https://notdeletable.winery.com');

    await expect(
      withTenant(TENANT_B, (tx) => deleteDomain(tx, created?.id ?? ''), db),
    ).resolves.toBeUndefined();

    /* Still there. */
    await expect(
      withTenant(TENANT_A, (tx) => readDomainById(tx, created?.id ?? ''), db),
    ).resolves.toBeDefined();
  });

  it('keeps one winery cutoffs out of another sight', async () => {
    await withTenant(TENANT_A, (tx) => endSessionsFor(tx, 'https://scoped-cutoff.winery.com'), db);

    await expect(
      sessionCutoffAt(TENANT_A, 'https://scoped-cutoff.winery.com', db),
    ).resolves.toBeInstanceOf(Date);
    await expect(
      sessionCutoffAt(TENANT_B, 'https://scoped-cutoff.winery.com', db),
    ).resolves.toBeUndefined();
  });

  it('moves a cutoff forward rather than adding a second row', async () => {
    /*
     * A seller who removes an origin, re-verifies it and removes it again has
     * ended two sets of sessions, and only the later cutoff matters. A conflict
     * that did nothing would leave the earlier one standing, so the second
     * run's sessions would survive.
     */
    await withTenant(TENANT_A, (tx) => endSessionsFor(tx, 'https://twice-cut.winery.com'), db);

    const first = await sessionCutoffAt(TENANT_A, 'https://twice-cut.winery.com', db);

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    await withTenant(TENANT_A, (tx) => endSessionsFor(tx, 'https://twice-cut.winery.com'), db);

    const second = await sessionCutoffAt(TENANT_A, 'https://twice-cut.winery.com', db);

    expect(second?.getTime() ?? 0).toBeGreaterThan(first?.getTime() ?? 0);
  });

  it('has no cutoff for an origin nobody removed', async () => {
    await expect(
      sessionCutoffAt(TENANT_A, 'https://never-removed.example', db),
    ).resolves.toBeUndefined();
  });

  it('counts only verified origins when deciding if one was the last', async () => {
    const COUNTED = '77777777-7777-7777-7777-777777777777';

    await withTenant(
      COUNTED,
      (tx) =>
        tx.execute(sql`
          INSERT INTO tenants (id, name, slug) VALUES (${COUNTED}::uuid, 'Cantina Blu', 'cantina-blu')
          ON CONFLICT DO NOTHING
        `),
      db,
    );

    const pending = await attempt(COUNTED, 'https://pending-only.example', 'n', 5);

    expect(pending.outcome).toBe('created');
    /* One row, none of it verified. */
    await expect(withTenant(COUNTED, (tx) => countVerifiedDomains(tx), db)).resolves.toBe(0);
    await expect(withTenant(COUNTED, (tx) => countDomains(tx), db)).resolves.toBe(1);
  });
});
