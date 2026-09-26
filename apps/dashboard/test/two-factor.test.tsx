import { ApiError } from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EnrolmentScreen } from '../src/features/security/EnrolmentScreen.js';
import { StepUpPrompt } from '../src/features/security/StepUpPrompt.js';
import {
  needsEnrolment,
  needsStepUp,
  setupKeyOf,
  TwoFactorError,
  type TwoFactorApi,
} from '../src/features/security/two-factor.js';

/**
 * The dashboard's two-factor screens (P4-11).
 *
 * What the server does with each call is proved against the real library in
 * `apps/api/test/mfa.integration.test.ts`. These assert the screens: that an
 * owner can get from a refusal to an enrolled account, that backup codes are
 * shown at the one moment they exist, and that a step-up retries only after the
 * server accepted the code.
 */

afterEach(cleanup);

const URI =
  'otpauth://totp/Sommelier%20AI:owner@cantina.example?secret=JBSWY3DPEHPK3PXP&issuer=Sommelier%20AI';

const fakeApi = (overrides: Partial<TwoFactorApi> = {}): TwoFactorApi & { calls: string[] } => {
  const calls: string[] = [];

  return {
    calls,
    enable: (password) => {
      calls.push(`enable:${password}`);
      return Promise.resolve({ totpURI: URI, backupCodes: ['aaaaa-11111', 'bbbbb-22222'] });
    },
    verifyTotp: (code) => {
      calls.push(`totp:${code}`);
      return Promise.resolve();
    },
    verifyBackupCode: (code) => {
      calls.push(`backup:${code}`);
      return Promise.resolve();
    },
    ...overrides,
  };
};

const type = (label: RegExp | string, value: string): void => {
  fireEvent.input(screen.getByLabelText(label), { target: { value } });
};

describe('the enrolment screen', () => {
  it('takes an owner from the password to an enrolled account', async () => {
    const api = fakeApi();
    render(<EnrolmentScreen enrolled={false} api={api} />);

    type('Password', 'the-password');
    fireEvent.click(screen.getByRole('button', { name: 'Continua' }));

    await screen.findByText(/Collega/u);
    type(/Codice dall/u, '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Attiva' }));

    await screen.findByText('La verifica in due passaggi è attiva.');
    expect(api.calls).toEqual(['enable:the-password', 'totp:123456']);
  });

  it('shows the backup codes at the one moment they exist, and the setup key', async () => {
    render(<EnrolmentScreen enrolled={false} api={fakeApi()} />);

    type('Password', 'the-password');
    fireEvent.click(screen.getByRole('button', { name: 'Continua' }));

    const codes = await screen.findByRole('list', { name: 'Codici di backup' });

    expect(codes.textContent).toContain('aaaaa-11111');
    expect(codes.textContent).toContain('bbbbb-22222');
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Apri/u }).getAttribute('href')).toBe(URI);
  });

  it('never turns a server value that is not an authenticator link into a link', async () => {
    render(
      <EnrolmentScreen
        enrolled={false}
        api={fakeApi({
          enable: () => Promise.resolve({ totpURI: 'javascript:alert(1)', backupCodes: [] }),
        })}
      />,
    );

    type('Password', 'the-password');
    fireEvent.click(screen.getByRole('button', { name: 'Continua' }));

    await screen.findByText(/Collega/u);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says what went wrong, and forgets nothing it should keep', async () => {
    render(
      <EnrolmentScreen
        enrolled={false}
        api={fakeApi({
          enable: () =>
            Promise.reject(new TwoFactorError(400, 'INVALID_PASSWORD', 'Invalid password')),
        })}
      />,
    );

    type('Password', 'wrong');
    fireEvent.click(screen.getByRole('button', { name: 'Continua' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Invalid password');
  });

  it('has nothing to do for somebody already enrolled', () => {
    render(<EnrolmentScreen enrolled api={fakeApi()} />);

    expect(screen.getByRole('status').textContent).toContain('attiva');
    expect(screen.queryByLabelText('Password')).toBeNull();
  });
});

describe('the step-up prompt', () => {
  it('retries the action only after the server accepted the code', async () => {
    const order: string[] = [];
    const api = fakeApi({
      verifyTotp: () => {
        order.push('verified');
        return Promise.resolve();
      },
    });

    render(<StepUpPrompt api={api} onVerified={() => order.push('retry')} onCancel={vi.fn()} />);

    type('Codice', '654321');
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));

    await waitFor(() => {
      expect(order).toEqual(['verified', 'retry']);
    });
  });

  it('does not retry on a refused code, and clears it for another try', async () => {
    const onVerified = vi.fn();
    render(
      <StepUpPrompt
        api={fakeApi({
          verifyTotp: () => Promise.reject(new TwoFactorError(401, 'INVALID_CODE', 'Invalid code')),
        })}
        onVerified={onVerified}
        onCancel={vi.fn()}
      />,
    );

    type('Codice', '000000');
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Codice non valido.');
    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>('Codice').value).toBe('');
  });

  it('says so when the account is locked, rather than calling the code wrong', async () => {
    render(
      <StepUpPrompt
        api={fakeApi({
          verifyTotp: () =>
            Promise.reject(new TwoFactorError(429, 'ACCOUNT_TEMPORARILY_LOCKED', 'x')),
        })}
        onVerified={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    type('Codice', '000000');
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Troppi tentativi');
  });

  it('takes a backup code instead, through the backup path', async () => {
    const api = fakeApi();
    render(<StepUpPrompt api={api} onVerified={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Usa un codice di backup' }));
    type('Codice di backup', 'aaaaa-11111');
    fireEvent.click(screen.getByRole('button', { name: 'Conferma' }));

    await waitFor(() => {
      expect(api.calls).toEqual(['backup:aaaaa-11111']);
    });
  });

  it('can be cancelled', () => {
    const onCancel = vi.fn();
    render(<StepUpPrompt api={fakeApi()} onVerified={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('reading the API refusals', () => {
  it('tells a step-up from an enrolment from anything else', () => {
    const stepUp = new ApiError(403, 'step_up_required', 'x', 'r');
    const enrol = new ApiError(403, 'mfa_required', 'x', 'r');
    const role = new ApiError(403, 'forbidden', 'x', 'r');

    expect([needsStepUp(stepUp), needsEnrolment(stepUp)]).toEqual([true, false]);
    expect([needsStepUp(enrol), needsEnrolment(enrol)]).toEqual([false, true]);
    expect([needsStepUp(role), needsEnrolment(role)]).toEqual([false, false]);
    expect(needsStepUp(new Error('step_up_required'))).toBe(false);
  });

  it('reads the setup key out of the link, in groups of four', () => {
    expect(setupKeyOf(URI)).toBe('JBSW Y3DP EHPK 3PXP');
    expect(setupKeyOf('otpauth://totp/x')).toBeUndefined();
    expect(setupKeyOf('not a url')).toBeUndefined();
  });
});
