import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  createTurnstileSettingsPort,
  suggestTurnstile,
  SUGGEST_AFTER_RATE_LIMITED,
  SUGGEST_AFTER_UNAUTHORIZED_ORIGINS,
  type TurnstileSettingsPort,
} from '../src/turnstile-settings.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * The Turnstile switch and its suggestion (P4-14), without a database. The
 * statements behind it are asserted against Postgres in
 * `turnstile.integration.test.ts`.
 */

const state = (enabled: boolean, unauthorizedOrigins: number, rateLimited: number) => ({
  enabled,
  signals: { unauthorizedOrigins, rateLimited },
});

describe('the suggestion', () => {
  it('is made once a key is being presented from origins it does not belong to', () => {
    expect(suggestTurnstile(state(false, SUGGEST_AFTER_UNAUTHORIZED_ORIGINS, 0))).toBe(true);
    expect(suggestTurnstile(state(false, SUGGEST_AFTER_UNAUTHORIZED_ORIGINS - 1, 0))).toBe(false);
  });

  it('is made once requests are being refused for rate at a script’s pace', () => {
    expect(suggestTurnstile(state(false, 0, SUGGEST_AFTER_RATE_LIMITED))).toBe(true);
    expect(suggestTurnstile(state(false, 0, SUGGEST_AFTER_RATE_LIMITED - 1))).toBe(false);
  });

  it('is not made for a winery that already has it on', () => {
    expect(suggestTurnstile(state(true, 10_000, 10_000))).toBe(false);
  });
});

describe('turning it on where it cannot be verified', () => {
  it('is refused before anything is written', async () => {
    const port = createTurnstileSettingsPort({
      available: false,
      audit: () => Promise.reject(new Error('audited a refusal')),
    });

    await expect(port.set('11111111-1111-4111-8111-111111111111', true)).rejects.toMatchObject({
      kind: 'conflict',
    });
  });
});

describe('the routes', () => {
  const calls: string[] = [];
  const fakePort: TurnstileSettingsPort = {
    read: (tenantId) => {
      calls.push(`read:${tenantId}`);
      return Promise.resolve({
        enabled: false,
        available: true,
        suggested: true,
        signals: { unauthorizedOrigins: 60, rateLimited: 0 },
      });
    },
    set: (tenantId, enabled) => {
      calls.push(`set:${tenantId}:${String(enabled)}`);
      return Promise.resolve({
        enabled,
        available: true,
        suggested: false,
        signals: { unauthorizedOrigins: 60, rateLimited: 0 },
      });
    },
  };

  const TENANT = '11111111-1111-1111-1111-111111111111';
  const app = (role: 'OWNER' | 'EDITOR' = 'OWNER') =>
    createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, role),
      turnstileSettings: fakePort,
    });

  const put = (built: ReturnType<typeof app>, body: unknown) =>
    built.request('/v1/dashboard/widget/turnstile', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('reads the setting for the caller’s own winery', async () => {
    calls.length = 0;

    const response = await app().request('/v1/dashboard/widget/turnstile');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ suggested: true });
    expect(calls).toEqual([`read:${TENANT}`]);
  });

  it('sets it from a body that carries enabled and nothing else', async () => {
    calls.length = 0;

    expect((await put(app(), { enabled: true })).status).toBe(200);
    expect(calls).toEqual([`set:${TENANT}:true`]);
  });

  it.each([
    ['no body', undefined],
    ['a string', { enabled: 'yes' }],
    ['a tenant as well', { enabled: true, tenantId: TENANT }],
  ])('refuses %s', async (_name, body) => {
    calls.length = 0;

    expect((await put(app(), body)).status).toBe(422);
    expect(calls).toEqual([]);
  });

  it('is the owner’s, not an editor’s', async () => {
    expect((await app('EDITOR').request('/v1/dashboard/widget/turnstile')).status).toBe(403);
    expect((await put(app('EDITOR'), { enabled: true })).status).toBe(403);
  });
});
