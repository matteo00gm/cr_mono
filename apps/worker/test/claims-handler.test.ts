import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The claim sweep's entry point and its mail composition (P4-18b).
 *
 * The driver is mocked: what matters here is that the handler runs the sweep
 * over what the database hands it, and that mail is composed the way the API
 * composes its own — logged outside production, suppression read as the winery
 * being written to.
 */

const suppressedFor: string[] = [];

vi.mock('@catalogorosso/db', () => ({
  readClaimWork: () => Promise.resolve([]),
  withTenant: (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    suppressedFor.push(tenantId);

    return fn({});
  },
  isSuppressed: (_tx: unknown, address: string) => Promise.resolve(address.startsWith('bounced')),
}));

const { handler, sendersFrom } = await import('../src/claims.js');

beforeEach(() => {
  suppressedFor.length = 0;
});

describe('the handler', () => {
  it('runs the sweep and reports what it did', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(handler()).resolves.toEqual({
      noticesSent: 0,
      settled: 0,
      outcomesTold: 0,
      failed: 0,
    });
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"kind":"claim_sweep"'));

    write.mockRestore();
  });
});

describe('the senders', () => {
  const props = {
    tenantName: 'Cantina',
    domain: 'https://www.winery.com',
    manageUrl: 'https://app.example/domini',
  };

  it('logs mail outside production rather than sending it', async () => {
    const lines: string[] = [];
    const send = sendersFrom(
      { SST_STAGE: 'dev', RESEND_API_KEY: 'unused' },
      {
        name: 'log',
        send: (email) => {
          lines.push(`${email.to}:${email.subject}`);

          return Promise.resolve({ id: 'log-1' });
        },
      },
    )('t1');

    await expect(
      send({ to: 'anna@example.com', template: 'domain-claim-lost', props }),
    ).resolves.toMatchObject({ status: 'sent', id: 'log-1' });
    expect(lines).toEqual(['anna@example.com:Cantina: https://www.winery.com è stato trasferito']);
  });

  it('checks suppression as the winery it is writing to', async () => {
    const send = sendersFrom(
      {},
      { name: 'log', send: () => Promise.resolve({ id: 'log-1' }) },
    )('t9');

    await expect(
      send({ to: 'bounced@example.com', template: 'domain-claim-lost', props }),
    ).resolves.toEqual({ status: 'suppressed', address: 'bounced@example.com' });
    expect(suppressedFor).toEqual(['t9']);
  });
});
