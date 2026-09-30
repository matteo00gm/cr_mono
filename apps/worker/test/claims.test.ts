import { describe, expect, it } from 'vitest';

import type { ClaimRecipients, ClaimWork } from '@catalogorosso/db';

import { formatDeadline, sweepClaims, type ClaimSweepDeps } from '../src/claims.js';

/**
 * The claim sweep, with every dependency injected (P4-18b).
 *
 * Who is told what, in which order, and what happens when a send fails. What
 * the sweep can *see* is a property of the policy, proved against real Postgres
 * in `packages/db`'s `claim-sweep.integration`; that a notice nobody was told
 * about cannot move an origin is proved there too, from the policy's side.
 */

const CLAIMANT = 'claimant-tenant';
const HOLDER = 'holder-tenant';

const work = (overrides: Partial<ClaimWork> = {}): ClaimWork => ({
  id: 'c1',
  claimantTenantId: CLAIMANT,
  incumbentTenantId: HOLDER,
  origin: 'https://www.winery.com',
  status: 'NOTICE',
  notifiedStatus: null,
  due: false,
  ...overrides,
});

const PEOPLE: Record<string, ClaimRecipients> = {
  [CLAIMANT]: { tenantName: 'Nuova Cantina', locale: 'it', owners: ['nuova@example.com'] },
  [HOLDER]: {
    tenantName: 'Vecchia Cantina',
    locale: 'en',
    owners: ['anna@example.com', 'bruno@example.com'],
  },
};

interface Sent {
  readonly tenantId: string;
  readonly to: string;
  readonly template: string;
  readonly locale: string | undefined;
  readonly props: Record<string, unknown>;
}

const harness = (
  items: readonly ClaimWork[],
  overrides: Partial<ClaimSweepDeps> & { readonly failFor?: string } = {},
) => {
  const events: string[] = [];
  const sent: Sent[] = [];
  const logged: string[] = [];

  const deps: ClaimSweepDeps = {
    manageUrl: 'https://app.example/domini',
    readWork: () => Promise.resolve(items),
    recipientsOf: (tenantId) => Promise.resolve(PEOPLE[tenantId]),
    senderFor: (tenantId) => (options) => {
      if (options.to === overrides.failFor) return Promise.reject(new Error('provider down'));

      events.push(`send:${options.template}:${options.to}`);
      sent.push({
        tenantId,
        to: options.to,
        template: options.template,
        locale: options.locale,
        props: options.props,
      });

      return Promise.resolve({ status: 'sent', id: 'x', attempts: 1 });
    },
    markNotified: (claim) => {
      events.push(`mark:${claim.id}:${claim.status}`);

      return Promise.resolve(new Date());
    },
    settle: (input) => {
      events.push(
        `settle:${input.claimId}:cap=${String(input.cap)}:hours=${String(input.noticeHours)}`,
      );

      return Promise.resolve({
        kind: 'transferred',
        basis: 'notice-expired',
        domain: {} as never,
      });
    },
    capOf: () => Promise.resolve(2),
    now: () => new Date('2026-09-30T08:00:00.000Z'),
    log: (line) => logged.push(line),
    ...overrides,
  };

  return { run: () => sweepClaims(deps), events, sent, logged };
};

describe('a notice not yet sent', () => {
  it('tells every owner of the holder, in the holder’s language, before stamping it', async () => {
    const { run, events, sent } = harness([work()]);

    await expect(run()).resolves.toEqual({
      noticesSent: 1,
      settled: 0,
      outcomesTold: 0,
      failed: 0,
    });
    expect(events).toEqual([
      'send:domain-claim-notice:anna@example.com',
      'send:domain-claim-notice:bruno@example.com',
      'mark:c1:NOTICE',
    ]);
    expect(sent[0]).toMatchObject({
      tenantId: HOLDER,
      locale: 'en',
      props: {
        tenantName: 'Vecchia Cantina',
        domain: 'https://www.winery.com',
        manageUrl: 'https://app.example/domini',
      },
    });
  });

  it('names the deadline the full notice period from now', async () => {
    const { run, sent } = harness([work()]);

    await run();

    expect(sent[0]?.props.transferOn).toBe(
      formatDeadline(new Date('2026-10-03T08:00:00.000Z'), 'en'),
    );
  });

  it('names nobody from the claimant’s side', async () => {
    const { run, sent } = harness([work()]);

    await run();

    expect(JSON.stringify(sent)).not.toContain('Nuova Cantina');
    expect(JSON.stringify(sent)).not.toContain(CLAIMANT);
  });
});

describe('a notice that was sent and has run out', () => {
  it('settles it with the claimant’s cap, then tells both sides', async () => {
    const { run, events } = harness([work({ due: true, notifiedStatus: 'NOTICE' })]);

    await expect(run()).resolves.toMatchObject({ settled: 1, outcomesTold: 1 });
    expect(events).toEqual([
      'settle:c1:cap=2:hours=72',
      'send:domain-claim-lost:anna@example.com',
      'send:domain-claim-lost:bruno@example.com',
      'send:domain-claim-won:nuova@example.com',
      'mark:c1:TRANSFERRED',
    ]);
  });

  it('does nothing more when the claim scope will not settle it', async () => {
    const { run, events } = harness([work({ due: true, notifiedStatus: 'NOTICE' })], {
      settle: () => Promise.resolve({ kind: 'unsettleable' }),
    });

    await expect(run()).resolves.toMatchObject({ settled: 0, outcomesTold: 0 });
    expect(events).toEqual([]);
  });
});

describe('an outcome not yet told', () => {
  it('tells only the holder of an immediate transfer: the claimant was at the screen', async () => {
    const { run, events } = harness([work({ status: 'TRANSFERRED' })]);

    await run();

    expect(events).toEqual([
      'send:domain-claim-lost:anna@example.com',
      'send:domain-claim-lost:bruno@example.com',
      'mark:c1:TRANSFERRED',
    ]);
  });

  it('tells nobody, and still records it, when nobody held the origin', async () => {
    const { run, events } = harness([work({ status: 'TRANSFERRED', incumbentTenantId: null })]);

    await run();

    expect(events).toEqual(['mark:c1:TRANSFERRED']);
  });

  it('tells the claimant its claim was withdrawn, in its own language', async () => {
    const { run, events, sent } = harness([work({ status: 'CANCELED', notifiedStatus: 'NOTICE' })]);

    await run();

    expect(events).toEqual(['send:domain-claim-withdrawn:nuova@example.com', 'mark:c1:CANCELED']);
    expect(sent[0]?.locale).toBe('it');
  });

  it('writes in Italian for a winery whose language it does not know', async () => {
    const { run, sent } = harness([work({ status: 'CANCELED' })], {
      recipientsOf: () =>
        Promise.resolve({ tenantName: 'X', locale: 'fr', owners: ['x@example.com'] }),
    });

    await run();

    expect(sent[0]?.locale).toBe('it');
  });

  it('records a claim whose winery no longer exists, having told nobody', async () => {
    const { run, events } = harness([work({ status: 'CANCELED' })], {
      recipientsOf: () => Promise.resolve(undefined),
    });

    await run();

    expect(events).toEqual(['mark:c1:CANCELED']);
  });
});

describe('a send that fails', () => {
  it('leaves that claim unstamped for the next run, and still serves the rest', async () => {
    /*
     * **Mail first, stamp second.** A notice stamped as sent when it was not
     * would start the holder's clock on a message nobody received — the one
     * failure this row exists to prevent.
     */
    const { run, events, logged } = harness(
      [work({ id: 'c1' }), work({ id: 'c2', status: 'CANCELED' })],
      { failFor: 'bruno@example.com' },
    );

    await expect(run()).resolves.toMatchObject({ noticesSent: 0, outcomesTold: 1, failed: 1 });
    expect(events).not.toContain('mark:c1:NOTICE');
    expect(events).toContain('mark:c2:CANCELED');
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] ?? '{}')).toEqual({
      level: 'error',
      kind: 'claim_sweep_failed',
      claimId: 'c1',
      type: 'Error',
    });
    /* No address in the log: the failure is about the claim, not a person. */
    expect(logged[0]).not.toContain('@');
  });
});

describe('the deadline as a seller reads it', () => {
  it('is Italian time, in either language', () => {
    const at = new Date('2026-10-03T08:00:00.000Z');

    /* Asserted by its parts: the exact joining words vary with the ICU a Node ships. */
    expect(formatDeadline(at, 'it')).toMatch(/^3 ottobre 2026.*10:00 \(ora italiana\)$/u);
    expect(formatDeadline(at, 'en')).toMatch(/^3 October 2026.*10:00 \(Italian time\)$/u);
  });
});
