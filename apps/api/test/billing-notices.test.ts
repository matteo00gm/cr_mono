import type { SendEmail } from '@catalogorosso/core';
import type { OwnerRecipients } from '@catalogorosso/db';
import { describe, expect, it, vi } from 'vitest';

import { createBillingNotifier } from '../src/billing-notices.js';
import { logger } from '../src/middleware/logger.js';

/**
 * What an applied billing event leaves to be done after commit: telling the
 * owners their widget went dark on a failed payment (P5-05a), and putting a
 * refused downgrade back in Stripe before telling them why (P5-10).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

interface Sent {
  readonly tenantId: string;
  readonly to: string;
  readonly template: string;
  readonly props: unknown;
  readonly locale: unknown;
}

const notifier = (
  recipients: OwnerRecipients | undefined,
  restorePlan?: (tenantId: string, plan: 'CANTINA' | 'ECOMMERCE') => Promise<void>,
) => {
  const sent: Sent[] = [];
  const notify = createBillingNotifier({
    restorePlan,
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

const PAYMENT_FAILED = { kind: 'payment_failed' } as const;

describe('a failed payment', () => {
  it('is told to every owner, in the winery’s language, with the way to fix it', async () => {
    const { sent, notify } = notifier({
      tenantName: 'Cantina Rossi',
      locale: 'en',
      owners: ['anna@rossi.example', 'marco@rossi.example'],
    });

    await notify(TENANT, PAYMENT_FAILED);

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

    await notify(TENANT, PAYMENT_FAILED);

    expect(sent[0]?.locale).toBe('it');
  });

  it('is sent through the winery’s own sender, whose suppression list is read in its scope', async () => {
    const { sent, notify } = notifier({
      tenantName: 'Cantina',
      locale: 'it',
      owners: ['o@c.example'],
    });

    await notify(TENANT, PAYMENT_FAILED);

    expect(sent.map((message) => message.tenantId)).toEqual([TENANT]);
  });

  it('is told to nobody when the winery is gone', async () => {
    const { sent, notify } = notifier(undefined);

    await notify(TENANT, PAYMENT_FAILED);

    expect(sent).toEqual([]);
  });

  it('is told to nobody when the winery has no owner to tell', async () => {
    const { sent, notify } = notifier({ tenantName: 'Cantina', locale: 'it', owners: [] });

    await notify(TENANT, PAYMENT_FAILED);

    expect(sent).toEqual([]);
  });
});

describe('a downgrade refused as it applied (P5-10)', () => {
  const DEFERRED = {
    kind: 'downgrade_deferred',
    kept: 'ECOMMERCE',
    wanted: 'CANTINA',
    reason:
      'Cantina allows 300 wines and 1 domain. To move to Cantina, archive 112 wines (412 of 300) first.',
  } as const;
  const RECIPIENTS = { tenantName: 'Cantina Rossi', locale: 'en', owners: ['anna@rossi.example'] };

  it('puts Stripe back on the plan kept, then tells every owner what to reduce', async () => {
    const restored: [string, string, number][] = [];
    const { sent, notify } = notifier(RECIPIENTS, (tenantId, plan) => {
      /* Stripe first: the email's retries must not hold the price wrong. */
      restored.push([tenantId, plan, sent.length]);
      return Promise.resolve();
    });

    await notify(TENANT, DEFERRED);

    expect(restored).toEqual([[TENANT, 'ECOMMERCE', 0]]);
    expect(sent).toEqual([
      {
        tenantId: TENANT,
        to: 'anna@rossi.example',
        template: 'downgrade-deferred',
        props: {
          tenantName: 'Cantina Rossi',
          keptPlan: 'E-commerce',
          wantedPlan: 'Cantina',
          reason: DEFERRED.reason,
          billingUrl: 'https://app.catalogorosso.com/fatturazione',
        },
        locale: 'en',
      },
    ]);
  });

  it('still tells the owners when Stripe cannot be put back — and says so loudly for the operator', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { sent, notify } = notifier(RECIPIENTS, () => Promise.reject(new Error('stripe down')));

    await notify(TENANT, DEFERRED);

    expect(sent.map((message) => message.template)).toEqual(['downgrade-deferred']);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'billing_restore_failed', type: 'ECOMMERCE' }),
      expect.any(String),
    );
  });

  it('tells the owners where there is no Stripe to put back', async () => {
    const { sent, notify } = notifier(RECIPIENTS);

    await notify(TENANT, DEFERRED);

    expect(sent.map((message) => message.template)).toEqual(['downgrade-deferred']);
  });

  it('is the only notice that touches Stripe', async () => {
    const restored: string[] = [];
    const { notify } = notifier(RECIPIENTS, (_tenantId, plan) => {
      restored.push(plan);
      return Promise.resolve();
    });

    await notify(TENANT, PAYMENT_FAILED);

    expect(restored).toEqual([]);
  });
});
