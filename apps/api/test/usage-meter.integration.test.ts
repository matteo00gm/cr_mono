import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type { SendEmail } from '@catalogorosso/core';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBillingPort } from '../src/billing.js';
import { createQuotaNotifier } from '../src/quota-notices.js';

/**
 * The month as a seller reads it, against real Postgres (P5-12): the meter
 * read from the ledger the gate counts, and the notices claimed in the winery's
 * own scope and sent to its owners once.
 */

let harness: TestDatabase | undefined;

const admin = () => {
  if (harness === undefined) throw new Error('no database');
  return harness.adminDb;
};

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

const NOW = new Date();
const PERIOD = `${String(NOW.getUTCFullYear())}${String(NOW.getUTCMonth() + 1).padStart(2, '0')}`;

const winery = async () => {
  const tenantId = randomUUID();

  await admin().execute(sql`
    INSERT INTO tenants (id, name, slug, status, plan, stripe_customer_id, stripe_subscription_id)
    VALUES (${tenantId}, 'Cantina Rossi', ${`um-${tenantId}`}, 'ACTIVE', 'CANTINA',
            ${`cus_${randomUUID()}`}, ${`sub_${randomUUID()}`})
  `);

  return tenantId;
};

const person = async (tenantId: string, role: 'OWNER' | 'EDITOR', email: string) => {
  const userId = `user_${randomUUID().slice(0, 8)}`;

  await admin().execute(sql`
    INSERT INTO auth_users (id, name, email) VALUES (${userId}, ${email}, ${email})
  `);
  await admin().execute(sql`
    INSERT INTO memberships (tenant_id, user_id, role) VALUES (${tenantId}, ${userId}, ${role})
  `);
};

describe('the notices, sent', () => {
  it('reach every owner once, however many turns cross the line together — and no editor', async () => {
    const tenantId = await winery();

    await person(tenantId, 'OWNER', `anna-${tenantId}@rossi.example`);
    await person(tenantId, 'EDITOR', `luca-${tenantId}@rossi.example`);

    const sent: { to: string; template: string }[] = [];
    const notify = createQuotaNotifier({
      dashboardOrigin: 'https://app.catalogorosso.com',
      sendEmailFor: () =>
        ((message: { to: string; template: string }) => {
          sent.push({ to: message.to, template: message.template });
          return Promise.resolve({ outcome: 'sent' });
        }) as unknown as SendEmail,
    });
    const cantina = { tenantId, plan: 'CANTINA' as const };

    await Promise.all([
      notify(cantina, 1_200, 1_500),
      notify(cantina, 1_201, 1_500),
      notify(cantina, 1_202, 1_500),
    ]);
    await notify(cantina, 1_500, 1_500);
    await notify(cantina, 1_501, 1_500);

    expect(sent).toEqual([
      { to: `anna-${tenantId}@rossi.example`, template: 'quota-warning' },
      { to: `anna-${tenantId}@rossi.example`, template: 'quota-exhausted' },
    ]);
  });
});

describe('the meter, read', () => {
  it('counts the ledger and what was bought, and says where the messages went', async () => {
    const tenantId = await winery();
    const session = `sess-${randomUUID()}`;

    await admin().execute(sql`
      INSERT INTO conversations (tenant_id, session_id, origin, locale)
      VALUES (${tenantId}, ${session}, 'https://www.cantina.example', 'it')
    `);
    await admin().execute(sql`
      INSERT INTO usage_events (tenant_id, period, kind, session_id)
      SELECT ${tenantId}::uuid, ${PERIOD}, 'chat_message', ${session} FROM generate_series(1, 3)
    `);
    await admin().execute(sql`
      INSERT INTO usage_events (tenant_id, period, kind) VALUES (${tenantId}::uuid, ${PERIOD}, 'embedding')
    `);
    await admin().execute(sql`
      INSERT INTO usage_top_ups (tenant_id, period, messages_purchased, stripe_payment_intent_id)
      VALUES (${tenantId}::uuid, ${PERIOD}, 1000, ${`pi_${randomUUID()}`})
    `);

    const usage = await createBillingPort({
      dashboardOrigin: 'https://app.catalogorosso.com',
      now: () => NOW,
    }).usage(tenantId);

    expect(usage).toMatchObject({
      period: PERIOD,
      plan: 'CANTINA',
      status: 'ACTIVE',
      used: 3,
      included: 1_500,
      purchased: 1_000,
      allowance: 2_500,
      state: 'ok',
      byOrigin: [{ origin: 'https://www.cantina.example', messages: 3 }],
    });
    expect(usage.byDay.reduce((total, day) => total + day.messages, 0)).toBe(3);
  });
});
