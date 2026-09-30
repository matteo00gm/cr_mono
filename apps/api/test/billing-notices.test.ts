import type { SendEmail } from '@catalogorosso/core';
import type { OwnerRecipients } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import { createBillingNotifier } from '../src/billing-notices.js';

/**
 * Telling the owners their widget went dark on a failed payment (P5-05a).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

interface Sent {
  readonly tenantId: string;
  readonly to: string;
  readonly template: string;
  readonly props: unknown;
  readonly locale: unknown;
}

const notifier = (recipients: OwnerRecipients | undefined) => {
  const sent: Sent[] = [];
  const notify = createBillingNotifier({
    dashboardOrigin: 'https://app.catalogorosso.com',
    recipientsOf: () => Promise.resolve(recipients),
    sendEmailFor: (tenantId) =>
      ((options: { to: string; template: string; props: unknown; locale: unknown }) => {
        sent.push({ tenantId, ...options });
        return Promise.resolve({ outcome: 'sent' });
      }) as unknown as SendEmail,
  });

  return { sent, notify };
};

describe('a failed payment', () => {
  it('is told to every owner, in the winery’s language, with the way to fix it', async () => {
    const { sent, notify } = notifier({
      tenantName: 'Cantina Rossi',
      locale: 'en',
      owners: ['anna@rossi.example', 'marco@rossi.example'],
    });

    await notify(TENANT, 'payment_failed');

    expect(sent).toEqual(
      ['anna@rossi.example', 'marco@rossi.example'].map((to) => ({
        tenantId: TENANT,
        to,
        template: 'payment-failed',
        props: {
          tenantName: 'Cantina Rossi',
          billingUrl: 'https://app.catalogorosso.com/fatturazione',
        },
        locale: 'en',
      })),
    );
  });

  it('is told in Italian when the winery’s language is not one we write', async () => {
    const { sent, notify } = notifier({
      tenantName: 'Weingut',
      locale: 'de',
      owners: ['o@w.example'],
    });

    await notify(TENANT, 'payment_failed');

    expect(sent[0]?.locale).toBe('it');
  });

  it('is sent through the winery’s own sender, whose suppression list is read in its scope', async () => {
    const { sent, notify } = notifier({
      tenantName: 'Cantina',
      locale: 'it',
      owners: ['o@c.example'],
    });

    await notify(TENANT, 'payment_failed');

    expect(sent.map((message) => message.tenantId)).toEqual([TENANT]);
  });

  it('is told to nobody when the winery is gone', async () => {
    const { sent, notify } = notifier(undefined);

    await notify(TENANT, 'payment_failed');

    expect(sent).toEqual([]);
  });

  it('is told to nobody when the winery has no owner to tell', async () => {
    const { sent, notify } = notifier({ tenantName: 'Cantina', locale: 'it', owners: [] });

    await notify(TENANT, 'payment_failed');

    expect(sent).toEqual([]);
  });
});
