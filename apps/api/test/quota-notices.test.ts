import type { SendEmail } from '@catalogorosso/core';
import type { OwnerRecipients } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import { createQuotaNotifier } from '../src/quota-notices.js';

/**
 * The 80% and 100% notices (P5-12): when each is sent, to whom, once, and
 * with which ways out.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-20T10:00:00Z');

interface Sent {
  readonly to: string;
  readonly template: string;
  readonly props: Record<string, unknown>;
  readonly locale: unknown;
}

const OWNERS: OwnerRecipients = {
  tenantName: 'Cantina Rossi',
  locale: 'it',
  owners: ['anna@rossi.example', 'marco@rossi.example'],
};

const notifier = ({
  recipients = OWNERS,
  claimed = new Set<string>(),
}: { recipients?: OwnerRecipients | null; claimed?: Set<string> } = {}) => {
  const sent: Sent[] = [];
  const claims: string[] = [];
  const notify = createQuotaNotifier({
    dashboardOrigin: 'https://app.catalogorosso.com',
    now: () => NOW,
    recipientsOf: () => Promise.resolve(recipients ?? undefined),
    claim: (tenantId, period, threshold) => {
      const key = `${tenantId}:${period}:${String(threshold)}`;

      claims.push(key);

      if (claimed.has(key)) return Promise.resolve(false);

      claimed.add(key);
      return Promise.resolve(true);
    },
    sendEmailFor: () =>
      ((message: Sent) => {
        sent.push(message);
        return Promise.resolve({ outcome: 'sent' });
      }) as unknown as SendEmail,
  });

  return { sent, claims, notify };
};

const cantina = { tenantId: TENANT, plan: 'CANTINA' as const };

describe('when a notice is sent', () => {
  it.each<[number, string | undefined]>([
    [79, undefined],
    [80, 'quota-warning'],
    [99, 'quota-warning'],
    [100, 'quota-exhausted'],
    [101, 'quota-exhausted'],
  ])('at %i%% of the month, %s', async (percent, template) => {
    const { sent, notify } = notifier();

    await notify(cantina, percent * 15, 1_500);

    expect(sent.map((message) => message.template)).toEqual(
      template === undefined ? [] : [template, template],
    );
  });

  it('is sent to every owner once per threshold, however many messages cross it', async () => {
    const { sent, claims, notify } = notifier();

    await notify(cantina, 1_200, 1_500);
    await notify(cantina, 1_201, 1_500);
    await notify(cantina, 1_202, 1_500);

    expect(sent.map((message) => message.to)).toEqual([
      'anna@rossi.example',
      'marco@rossi.example',
    ]);
    expect(claims).toEqual(Array.from({ length: 3 }, () => `${TENANT}:202610:80`));
  });

  it('claims before it sends, so a lost claim sends nothing', async () => {
    const { sent, notify } = notifier({ claimed: new Set([`${TENANT}:202610:100`]) });

    await notify(cantina, 1_500, 1_500);

    expect(sent).toEqual([]);
  });

  it('asks nothing of the claim below the first threshold', async () => {
    const { claims, notify } = notifier();

    await notify(cantina, 10, 1_500);

    expect(claims).toEqual([]);
  });

  it('is sent to nobody when the winery is gone', async () => {
    const { sent, notify } = notifier({ recipients: null });

    await notify(cantina, 1_500, 1_500);

    expect(sent).toEqual([]);
  });
});

describe('what a notice offers', () => {
  it('a top-up and the next plan, each a link to its button on the Fatturazione screen', async () => {
    const { sent, notify } = notifier();

    await notify(cantina, 1_200, 1_500);

    expect(sent[0]).toEqual({
      to: 'anna@rossi.example',
      template: 'quota-warning',
      locale: 'it',
      props: {
        tenantName: 'Cantina Rossi',
        usedPercent: 80,
        periodEndsOn: '1 novembre 2026',
        topUp: {
          url: 'https://app.catalogorosso.com/fatturazione#ricarica',
          price: '€15',
          messages: 1_000,
        },
        upgrade: {
          plan: 'E-commerce',
          price: '€79',
          url: 'https://app.catalogorosso.com/fatturazione#piano',
        },
      },
    });
  });

  it('the top-up alone on the top plan', async () => {
    const { sent, notify } = notifier();

    await notify({ tenantId: TENANT, plan: 'ECOMMERCE' }, 6_000, 6_000);

    expect(sent[0]?.props).toMatchObject({ topUp: { price: '€15' }, upgrade: null });
  });

  it('a plan alone to a winery with none, which a top-up cannot be added to', async () => {
    const { sent, notify } = notifier();

    await notify({ tenantId: TENANT, plan: null }, 150, 150);

    expect(sent[0]?.props).toMatchObject({
      topUp: null,
      upgrade: { plan: 'Cantina', price: '€29' },
    });
  });

  it('dates the reset in the winery’s language', async () => {
    const { sent, notify } = notifier({ recipients: { ...OWNERS, locale: 'en' } });

    await notify(cantina, 1_500, 1_500);

    expect(sent[0]).toMatchObject({ locale: 'en', props: { periodEndsOn: '1 November 2026' } });
  });
});
