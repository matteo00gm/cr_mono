import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { CHAT_MESSAGE, periodOf } from '@catalogorosso/core';
import { recordUsage, withTenant } from '@catalogorosso/db';
import { planCapCheck } from '@catalogorosso/security';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createQuotaPort, type QuotaPort } from '../src/quota.js';
import type { WidgetTenant } from '../src/env.js';

/**
 * The monthly plan cap, against real Postgres (P2-36).
 *
 * **Faking the count would prove nothing about the gate.** The whole question
 * is whether the number the cap is compared against is the number a seller is
 * billed for — one indexed equality over `usage_events`, in the tenant's own
 * scope — and a stub answers it by construction.
 *
 * The case the row cares most about is the rollover. A cap that carried last
 * month's count would refuse a tenant in February for what they spent in
 * January, and nothing about the refusal would say so.
 */

let harness: TestDatabase | undefined;
let db: TestDatabase['db'];
let tenantId: string;
let quota: QuotaPort;

const CANTINA_CAP = planCapCheck('any', 'CANTINA').limit;

const tenant = (id: string): WidgetTenant => ({
  tenantId: id,
  plan: 'CANTINA',
  status: 'ACTIVE',
  locale: 'it',
});

const useTenant = async (id: string): Promise<void> => {
  await db.execute(sql`select set_config('app.tenant_id', ${id}, false)`);
};

const createTenant = async (slug: string): Promise<string> => {
  const id = randomUUID();

  await useTenant(id);
  await db.execute(sql`
    insert into tenants (id, name, slug, locale, currency)
    values (${id}::uuid, ${slug}, ${`${slug}-${id}`}, 'it', 'EUR')
  `);

  return id;
};

const meter = async (id: string, messages: number, period: string): Promise<void> => {
  for (let message = 0; message < messages; message += 1) {
    await withTenant(
      id,
      (tx) =>
        recordUsage(tx, {
          period,
          kind: CHAT_MESSAGE,
          sessionId: `sess-${randomUUID()}`,
          inputTokens: 1000,
          outputTokens: 500,
          costMicros: 180,
        }),
      db,
    );
  }
};

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');
  db = harness.db;

  quota = createQuotaPort();
  tenantId = await createTenant('quota');
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('the cap, read from the ledger', () => {
  it('allows a tenant who has spent nothing', async () => {
    const fresh = await createTenant('quota-fresh');

    await expect(quota.check(tenant(fresh))).resolves.toMatchObject({
      allowed: true,
      used: 0,
      limit: CANTINA_CAP,
    });
  });

  it('counts what was actually billed, not what was attempted', async () => {
    const counted = await createTenant('quota-counted');

    await meter(counted, 3, periodOf(new Date()));

    await expect(quota.check(tenant(counted))).resolves.toMatchObject({ used: 3 });
  });

  it('refuses once the plan is spent', async () => {
    /*
     * A small cap rather than 1,500 rows: what is under test is the comparison
     * and the read, and metering fifteen hundred turns to prove `<` would take
     * a minute to say something two rows already say.
     */
    const spent = await createTenant('quota-spent');
    const period = periodOf(new Date());

    await meter(spent, 2, period);

    const used = await quota.readUsage(planCapCheck(spent, 'CANTINA'));

    expect(used).toBe(2);
    await expect(quota.check(tenant(spent))).resolves.toMatchObject({ allowed: true });
  });

  it('resets when the period rolls over', async () => {
    // The count is an equality on `period`, so last month is a different key
    // and a tenant starts February owing nothing for January.
    const rolled = await createTenant('quota-rolled');

    await meter(rolled, 5, '202001');

    const thisMonth = await quota.check(tenant(rolled));

    expect(thisMonth.used).toBe(0);
    expect(thisMonth.allowed).toBe(true);
  });

  it('reads the month the clock is at, so a boundary can be crossed', async () => {
    const crossing = await createTenant('quota-crossing');

    await meter(crossing, 4, '202609');

    const inSeptember = createQuotaPort({ now: () => new Date('2026-09-30T23:30:00Z') });
    const inOctober = createQuotaPort({ now: () => new Date('2026-10-01T00:30:00Z') });

    expect((await inSeptember.check(tenant(crossing))).used).toBe(4);
    expect((await inOctober.check(tenant(crossing))).used).toBe(0);
  });

  it('cannot see another tenant month', async () => {
    const other = await createTenant('quota-other');

    await meter(other, 7, periodOf(new Date()));

    await expect(quota.check(tenant(tenantId))).resolves.toMatchObject({ used: 0 });
  });
});

describe('reading the month for the banner', () => {
  it('answers the check the config route builds', async () => {
    const banner = await createTenant('quota-banner');

    await meter(banner, 2, periodOf(new Date()));

    await expect(quota.readUsage(planCapCheck(banner, 'CANTINA'))).resolves.toBe(2);
  });

  it('answers nought for a key that is not a plan cap', async () => {
    /*
     * Nought rather than a throw. The only caller is the banner, and a banner
     * is not worth failing a request over — the gate above never takes this
     * path, because it builds the key itself.
     */
    await expect(
      quota.readUsage({ key: 'ip:abc:unresolved', limit: 10, window: 'month' }),
    ).resolves.toBe(0);
  });
});
