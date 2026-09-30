import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Development mode's port, with the driver mocked (P4-19b): which statements
 * run, what is audited, which sessions end. The routes are
 * `dev-mode-route.test.ts`; that the grant ends on time is the policy's, proved
 * in `packages/db`'s `dev-mode.integration`.
 */

const calls: string[] = [];
const state = {
  previous: undefined as { origin: string; expiresAt: Date } | undefined,
  ended: undefined as string | undefined,
};
const AT = new Date('2026-10-01T09:00:00.000Z');

vi.mock('@catalogorosso/db', () => ({
  withTenant: (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    calls.push(`withTenant(${tenantId})`);

    return fn({});
  },
  readDevMode: () => {
    calls.push('readDevMode');

    return Promise.resolve(state.previous);
  },
  enableDevMode: (_tx: unknown, origin: string, hours: number) => {
    calls.push(`enableDevMode(${origin},${String(hours)})`);

    return Promise.resolve({ origin, expiresAt: AT });
  },
  endDevMode: () => {
    calls.push('endDevMode');

    return Promise.resolve(state.ended);
  },
  endSessionsFor: (_tx: unknown, origin: string) => {
    calls.push(`endSessionsFor(${origin})`);

    return Promise.resolve();
  },
}));

const { createDevMode } = await import('../src/dev-mode.js');

const written: { action: string; target?: string }[] = [];
const port = () =>
  createDevMode({
    audit: (_tx, entry) => {
      written.push(entry as { action: string; target?: string });

      return Promise.resolve();
    },
  });

beforeEach(() => {
  calls.length = 0;
  written.length = 0;
  state.previous = undefined;
  state.ended = undefined;
});

describe('the port', () => {
  it('reads a live grant, and reads a missing one as off', async () => {
    await expect(port().devMode('t1')).resolves.toEqual({
      active: false,
      origin: null,
      expiresAt: null,
    });

    state.previous = { origin: 'http://localhost:3000', expiresAt: AT };

    await expect(port().devMode('t1')).resolves.toEqual({
      active: true,
      origin: 'http://localhost:3000',
      expiresAt: AT.toISOString(),
    });
  });

  it('grants a local origin for a day, normalised, and audits it', async () => {
    await expect(
      port().enableDevMode({ tenantId: 't1', input: 'HTTP://LOCALHOST:3000/' }),
    ).resolves.toEqual({
      active: true,
      origin: 'http://localhost:3000',
      expiresAt: AT.toISOString(),
    });
    expect(calls).toContain('enableDevMode(http://localhost:3000,24)');
    expect(written).toEqual([
      { action: 'widget.dev_mode_enabled', target: 'http://localhost:3000' },
    ]);
  });

  it('refuses anything that is not a local origin, before opening anything', async () => {
    await expect(
      port().enableDevMode({ tenantId: 't1', input: 'https://winery.com' }),
    ).rejects.toMatchObject({ kind: 'invalid' });
    expect(calls).toEqual([]);
  });

  it('ends the sessions of a grant it replaces for another origin', async () => {
    state.previous = { origin: 'http://localhost:4000', expiresAt: AT };

    await port().enableDevMode({ tenantId: 't1', input: 'http://localhost:3000' });

    expect(calls).toContain('endSessionsFor(http://localhost:4000)');
  });

  it('leaves the sessions alone when the grant is renewed for the same origin', async () => {
    state.previous = { origin: 'http://localhost:3000', expiresAt: AT };

    await port().enableDevMode({ tenantId: 't1', input: 'http://localhost:3000' });

    expect(calls.some((call) => call.startsWith('endSessionsFor'))).toBe(false);
  });

  it('ends a grant, its sessions, and audits it', async () => {
    state.ended = 'http://localhost:3000';

    await expect(port().endDevMode('t1')).resolves.toEqual({
      active: false,
      origin: null,
      expiresAt: null,
    });
    expect(calls).toEqual([
      'withTenant(t1)',
      'endDevMode',
      'endSessionsFor(http://localhost:3000)',
    ]);
    expect(written).toEqual([{ action: 'widget.dev_mode_ended', target: 'http://localhost:3000' }]);
  });

  it('ends nothing quietly when there was no grant', async () => {
    await port().endDevMode('t1');

    expect(written).toEqual([]);
    expect(calls.some((call) => call.startsWith('endSessionsFor'))).toBe(false);
  });
});
