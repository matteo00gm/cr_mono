import { randomUUID } from 'node:crypto';

import type { SecurityEvent } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import { refusalRecorders } from '../src/security-events.js';
import type { TokenRefusal } from '../src/widget-token.js';

/**
 * What a refusal becomes in `security_events` (P2-16).
 *
 * The statement is asserted in `packages/db`; what is asserted here is the
 * mapping — which type counts a refusal, and what travels with it. A wrong type
 * is not a failure anybody sees: it is a panel (P6-05) that quietly counts the
 * wrong thing, and an alert threshold measured against it.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://cantina-rossi.example';

const recorded = () => {
  const events: SecurityEvent[] = [];
  const recorders = refusalRecorders((event) => {
    events.push(event);
    return Promise.resolve();
  });

  return { events, ...recorders };
};

describe('a refused widget request (P2-08)', () => {
  it('is recorded under the type the guard already named, with what was claimed', async () => {
    const { events, onRejected } = recorded();
    const publicKey = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

    await onRejected({
      type: 'UNAUTHORIZED_ORIGIN',
      tenantId: TENANT,
      origin: 'https://evil.example',
      publicKey,
      ipBucket: 'a-bucket',
    });

    expect(events).toEqual([
      {
        type: 'UNAUTHORIZED_ORIGIN',
        tenantId: TENANT,
        origin: 'https://evil.example',
        publicKey,
        ipBucket: 'a-bucket',
      },
    ]);
  });

  it('records an unknown key as belonging to no tenant, which is why it was refused', async () => {
    const { events, onRejected } = recorded();

    await onRejected({ type: 'INVALID_KEY', origin: ORIGIN, publicKey: undefined });

    expect(events[0]).toMatchObject({ type: 'INVALID_KEY', tenantId: undefined });
  });
});

describe('a refused token (P2-13)', () => {
  const cases: readonly [TokenRefusal, string][] = [
    ['absent', 'INVALID_TOKEN'],
    ['invalid', 'INVALID_TOKEN'],
    ['malformed', 'INVALID_TOKEN'],
    ['revoked', 'INVALID_TOKEN'],
    ['origin_mismatch', 'TOKEN_ORIGIN_MISMATCH'],
    ['tenant_mismatch', 'TOKEN_ORIGIN_MISMATCH'],
  ];

  it.each(cases)('%s is counted as %s', async (reason, type) => {
    const { events, onTokenRejected } = recorded();

    await onTokenRejected({ reason, tenantId: TENANT, origin: ORIGIN, ipBucket: 'a-bucket' });

    expect(events).toEqual([
      {
        type,
        tenantId: TENANT,
        origin: ORIGIN,
        ipBucket: 'a-bucket',
        // The type is what a panel groups by; the reason is what a person reads.
        metadata: { reason },
      },
    ]);
  });

  it('keeps every reason distinguishable in the row, even where two share a type', async () => {
    const { events, onTokenRejected } = recorded();

    await onTokenRejected({ reason: 'origin_mismatch', tenantId: TENANT, origin: ORIGIN });
    await onTokenRejected({ reason: 'tenant_mismatch', tenantId: TENANT, origin: ORIGIN });

    expect(events.map((event) => event.metadata)).toEqual([
      { reason: 'origin_mismatch' },
      { reason: 'tenant_mismatch' },
    ]);
  });
});
