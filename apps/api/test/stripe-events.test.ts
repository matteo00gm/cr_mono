import type { ClaimedRun, DbTransaction, WebhookEvent } from '@catalogorosso/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../src/middleware/logger.js';
import {
  createStripeEventsPort,
  type AttributedDelivery,
  type StripeDelivery,
} from '../src/stripe-events.js';

/**
 * The Stripe events port (P5-04): which winery, claimed once, applied on the
 * claiming transaction. The claim itself is real Postgres's to prove
 * (`tenant-webhooks.integration.test.ts`); here it is recorded.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

const delivery = (object: Record<string, unknown>): StripeDelivery => ({
  eventId: 'evt_1',
  type: 'customer.subscription.updated',
  payload: { id: 'evt_1', type: 'customer.subscription.updated', data: { object } },
});

interface Claimed {
  readonly tenantId: string;
  readonly event: WebhookEvent;
}

/** A claim that records what it was asked, and either admits the event or has seen it. */
const recordingClaim = (claimed: boolean) => {
  const calls: Claimed[] = [];
  const tx = {} as DbTransaction;

  const claim = async <T>(
    tenantId: string,
    event: WebhookEvent,
    apply: (tx: DbTransaction) => Promise<T>,
  ): Promise<ClaimedRun<T>> => {
    calls.push({ tenantId, event });

    return claimed ? { claimed: true, result: await apply(tx) } : { claimed: false };
  };

  return { calls, claim, tx };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an event that names a winery', () => {
  it('is claimed under that winery, by provider and event id, and applied on the claim', async () => {
    const { calls, claim, tx } = recordingClaim(true);
    const applied: [DbTransaction, AttributedDelivery][] = [];
    const port = createStripeEventsPort({
      claim,
      apply: (on, attributed) => {
        applied.push([on, attributed]);
        return Promise.resolve(true);
      },
    });

    const sent = delivery({ metadata: { tenant_id: TENANT } });

    expect(await port.record(sent)).toEqual({ duplicate: false, applied: true });
    expect(calls).toEqual([{ tenantId: TENANT, event: { provider: 'stripe', eventId: 'evt_1' } }]);
    expect(applied).toEqual([[tx, { ...sent, tenantId: TENANT }]]);
  });

  it('reports an event that changed nothing as not applied', async () => {
    const { claim } = recordingClaim(true);
    const port = createStripeEventsPort({ claim, apply: () => Promise.resolve(false) });

    expect(await port.record(delivery({ metadata: { tenant_id: TENANT } }))).toEqual({
      duplicate: false,
      applied: false,
    });
  });

  it('reports a redelivery as a duplicate, and does not apply it', async () => {
    const { claim } = recordingClaim(false);
    const apply = vi.fn(() => Promise.resolve(true));
    const port = createStripeEventsPort({ claim, apply });

    expect(await port.record(delivery({ metadata: { tenant_id: TENANT } }))).toEqual({
      duplicate: true,
      applied: false,
    });
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('an event that names nobody', () => {
  it('is acknowledged, logged by type, and never claimed or applied', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { calls, claim } = recordingClaim(true);
    const apply = vi.fn(() => Promise.resolve(true));
    const port = createStripeEventsPort({ claim, apply });

    expect(await port.record(delivery({ metadata: { tenantId: TENANT } }))).toEqual({
      duplicate: false,
      applied: false,
    });
    expect(calls).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { kind: 'stripe_event_unattributed', type: 'customer.subscription.updated' },
      expect.any(String),
    );
  });
});
