import { describe, expect, it, vi } from 'vitest';

import {
  createSendEmail,
  InvalidRecipientError,
  noSuppression,
  type SendEmailDeps,
} from '../../src/email/send.js';
import {
  chooseTransport,
  EmailSendError,
  logTransport,
  resendTransport,
  type EmailTransport,
  type OutboundEmail,
} from '../../src/email/transport.js';

/**
 * The send seam (P0-64).
 *
 * No network and no clock. Every dependency that would make this slow or flaky
 * — the transport, the suppression read, the sleep, the jitter — is a
 * constructor argument, which is the same reason `ParameterStore` is a port.
 */

const INVITE = {
  to: 'Bob@Example.com',
  template: 'invite',
  props: {
    tenantName: 'Cantina Rossi',
    inviterEmail: 'anna@cantina.example',
    acceptUrl: 'https://app.example/invite/abc',
    expiresInDays: 7,
  },
} as const;

/** Records what it was asked to send and answers with a fixed id. */
const recording = (): { transport: EmailTransport; sent: OutboundEmail[] } => {
  const sent: OutboundEmail[] = [];
  return {
    sent,
    transport: {
      name: 'recording',
      send: (email) => {
        sent.push(email);
        return Promise.resolve({ id: 'msg_1' });
      },
    },
  };
};

const deps = (
  overrides: Partial<SendEmailDeps> & Pick<SendEmailDeps, 'transport'>,
): SendEmailDeps => ({
  from: 'Sommelier <noreply@sommelier.example>',
  suppression: noSuppression,
  // Deterministic, and instant: full jitter with `random() === 1` is the
  // longest delay the backoff can produce, which is the one worth asserting.
  random: () => 1,
  sleep: () => Promise.resolve(),
  ...overrides,
});

describe('sendEmail', () => {
  it('hands the transport a normalised address, both body parts, and the locale', async () => {
    const { transport, sent } = recording();
    const send = createSendEmail(deps({ transport }));

    const outcome = await send({ ...INVITE, locale: 'en' });

    expect(outcome).toEqual({ status: 'sent', id: 'msg_1', attempts: 1 });

    const message = sent[0];
    // Lowercased on the way through, so the address that reaches the provider
    // is the same string the suppression list is keyed by.
    expect(message?.to).toBe('bob@example.com');
    expect(message?.from).toBe('Sommelier <noreply@sommelier.example>');
    expect(message?.subject).toContain('invited');
    expect(message?.html).toContain('<html lang="en">');
    expect(message?.text).toContain('https://app.example/invite/abc');
  });

  it('defaults to Italian', async () => {
    const { transport, sent } = recording();
    await createSendEmail(deps({ transport }))(INVITE);

    // The customers are Italian wine sellers, so the default is the one a
    // caller that forgot to pass a locale should get.
    expect(sent[0]?.html).toContain('<html lang="it">');
    expect(sent[0]?.subject).toContain('invito');
  });

  it('does not send to a suppressed address', async () => {
    const { transport, sent } = recording();
    const send = createSendEmail(
      deps({
        transport,
        suppression: { isSuppressed: (address) => Promise.resolve(address === 'bob@example.com') },
      }),
    );

    const outcome = await send(INVITE);

    expect(outcome).toEqual({ status: 'suppressed', address: 'bob@example.com' });
    // The whole point: nothing reached the provider.
    expect(sent).toHaveLength(0);
  });

  it('checks the suppression list with the normalised address', async () => {
    // Otherwise a bounce recorded for `bob@example.com` would not suppress mail
    // addressed to `Bob@Example.com` — half a suppression, which is none.
    const isSuppressed = vi.fn((address: string) => Promise.resolve(address === 'never'));
    await createSendEmail(
      deps({ transport: recording().transport, suppression: { isSuppressed } }),
    )(INVITE);

    expect(isSuppressed).toHaveBeenCalledWith('bob@example.com');
  });

  it('retries a 429 with growing backoff, then succeeds', async () => {
    const delays: number[] = [];
    let calls = 0;

    const transport: EmailTransport = {
      name: 'flaky',
      send: () => {
        calls += 1;
        if (calls < 3) throw new EmailSendError('rate limited', 429, true);
        return Promise.resolve({ id: 'msg_late' });
      },
    };

    const outcome = await createSendEmail(
      deps({
        transport,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      }),
    )(INVITE);

    expect(outcome).toEqual({ status: 'sent', id: 'msg_late', attempts: 3 });
    // Growing, not fixed: 500 then 1000 at full jitter. A batch that all backs
    // off by the same amount retries in lockstep and hits the limit together.
    expect(delays).toEqual([500, 1000]);
  });

  it('does not retry a rejection the provider will repeat', async () => {
    let calls = 0;
    const transport: EmailTransport = {
      name: 'refusing',
      send: () => {
        calls += 1;
        throw new EmailSendError('domain not verified', 403, false);
      },
    };

    const failures: unknown[] = [];
    const send = createSendEmail(
      deps({ transport, onFailure: (failure) => failures.push(failure) }),
    );

    await expect(send(INVITE)).rejects.toThrow('domain not verified');

    // Once. Retrying a 403 spends the free tier's daily allowance — shared with
    // the password resets — on a message that cannot be accepted.
    expect(calls).toBe(1);
    expect(failures[0]).toMatchObject({ to: 'bob@example.com', template: 'invite', attempts: 1 });
  });

  it('raises the alarm once retries are exhausted, and still throws', async () => {
    const transport: EmailTransport = {
      name: 'down',
      send: () => {
        throw new EmailSendError('bad gateway', 502, true);
      },
    };

    const failures: { attempts: number }[] = [];
    const send = createSendEmail(
      deps({ transport, onFailure: (failure) => failures.push(failure) }),
    );

    await expect(send(INVITE)).rejects.toThrow('bad gateway');

    /*
     * Both, deliberately. The hook is what makes the alarm independent of every
     * caller remembering to log; the throw is what stops a caller believing a
     * password reset was delivered when it was not.
     */
    expect(failures).toEqual([expect.objectContaining({ attempts: 3 })]);
  });

  it('refuses an address that is obviously a bug on our side', async () => {
    const { transport, sent } = recording();
    const send = createSendEmail(deps({ transport }));

    await expect(send({ ...INVITE, to: 'undefined' })).rejects.toThrow(InvalidRecipientError);
    // A guaranteed bounce counts against the sending domain exactly as a real
    // one does, so this must not reach the provider.
    expect(sent).toHaveLength(0);
  });
});

describe('chooseTransport', () => {
  const provider: EmailTransport = {
    name: 'resend',
    send: () => Promise.reject(new Error('the provider must not be reached from a non-prod stage')),
  };

  it('sends through the provider in production', async () => {
    const { transport: real, sent } = recording();
    const chosen = chooseTransport({ stage: 'production', provider: real, log: logTransport() });

    await chosen.send({
      to: 'bob@example.com',
      from: 'a@b.example',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
    });

    expect(sent).toHaveLength(1);
  });

  it('cannot reach the provider from a non-production stage', async () => {
    /*
     * The assertion the row asks for by name, and the reason it is asked for:
     * a staging run against a restored production database must not be able to
     * mail real customers. The provider double rejects, so if the guard ever
     * routes to it this test fails loudly rather than silently sending.
     */
    const lines: string[] = [];
    const chosen = chooseTransport({
      stage: 'dev',
      provider,
      log: logTransport((line) => lines.push(line)),
    });

    const result = await chosen.send({
      to: 'real.customer@example.com',
      from: 'a@b.example',
      subject: 'Reimposta la tua password',
      html: '<p>h</p>',
      text: 'Reimposta la password:\nhttps://app.example/reset/xyz',
    });

    expect(result.id).toMatch(/^log-/);
    expect(lines[0]).toContain('real.customer@example.com');
    // The whole rendered message reaches the log, so a template bug is visible
    // in development rather than only in production.
    expect(lines[0]).toContain('https://app.example/reset/xyz');
  });

  it('lets an allowlisted address through, case-insensitively', async () => {
    const { transport: real, sent } = recording();
    const chosen = chooseTransport({
      stage: 'dev',
      provider: real,
      log: logTransport(() => undefined),
      allowlist: ['Dev@Sommelier.example'],
    });

    await chosen.send({
      to: 'dev@sommelier.example',
      from: 'a@b.example',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
    });

    // The exception is per recipient rather than a flag that switches the whole
    // stage over: a flag is one careless deploy away from mailing a customer
    // list, an address list can only ever reach the addresses on it.
    expect(sent).toHaveLength(1);
  });
});

describe('resendTransport', () => {
  /** Typed as the real thing, so argument access is not a zero-length tuple. */
  const fetchDouble = (response: Response) =>
    vi.fn(() => Promise.resolve(response)) as unknown as typeof globalThis.fetch;

  const message: OutboundEmail = {
    to: 'bob@example.com',
    from: 'Sommelier <noreply@sommelier.example>',
    subject: 'Ciao',
    html: '<p>ciao</p>',
    text: 'ciao',
  };

  it('posts both body parts and returns the provider id', async () => {
    const doubled = fetchDouble(Response.json({ id: 'msg_provider' }));
    const result = await resendTransport({ apiKey: 'k', fetch: doubled }).send(message);

    expect(result).toEqual({ id: 'msg_provider' });

    const [url, init] = vi.mocked(doubled).mock.calls[0] ?? [];
    expect(url).toBe('https://api.resend.com/emails');
    // `body` is a string here by construction — the transport stringifies it —
    // but its declared type is the whole BodyInit union, which includes types
    // that stringify to "[object Object]".
    const raw = init?.body;
    expect(typeof raw).toBe('string');
    const body = JSON.parse(raw as string) as Record<string, unknown>;
    expect(body).toMatchObject({ to: ['bob@example.com'], html: '<p>ciao</p>', text: 'ciao' });
  });

  it('marks 429 and 5xx retryable, and everything else not', async () => {
    const statusOf = async (status: number): Promise<boolean> => {
      const doubled = fetchDouble(new Response('nope', { status }));
      try {
        await resendTransport({ apiKey: 'k', fetch: doubled }).send(message);
      } catch (error: unknown) {
        return error instanceof EmailSendError && error.retryable;
      }
      throw new Error(`${String(status)} did not throw`);
    };

    expect(await statusOf(429)).toBe(true);
    expect(await statusOf(503)).toBe(true);
    // A malformed address or an unverified domain is rejected identically on
    // every attempt; retrying it only spends the daily allowance.
    expect(await statusOf(422)).toBe(false);
    expect(await statusOf(403)).toBe(false);
  });

  it('treats an accepted message with no id as a failure', async () => {
    // Without an id a later bounce webhook cannot be matched to what we sent,
    // which is the input the suppression list is built from.
    const doubled = fetchDouble(Response.json({}));
    await expect(resendTransport({ apiKey: 'k', fetch: doubled }).send(message)).rejects.toThrow(
      /no id/,
    );
  });
});
