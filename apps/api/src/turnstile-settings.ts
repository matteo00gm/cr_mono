import { audit as auditRow, ConflictError, type AuditEntry } from '@catalogorosso/core';
import type { TurnstileSettingsResponse } from '@catalogorosso/api-client';
import {
  readTurnstileState,
  setTurnstileEnabled,
  withTenant,
  type DbTransaction,
  type TurnstileState,
} from '@catalogorosso/db';

/**
 * Turning Turnstile on for a winery, and suggesting when to (P4-14).
 *
 * **Suggested automatically, enabled by a person.** The row asks for an
 * automatic enable that a human confirms, and this is that, without a job: the
 * last hour's refusals are counted from `security_events` whenever the owner
 * looks, and `suggested` says whether they cross the line. Turning it on is the
 * owner's click — a challenge in front of every visitor is a cost, and the
 * person who pays it decides.
 */

/**
 * The lines, per hour. A handful of stray origins is a seller testing on a
 * staging host; fifty is somebody running the widget on a site that is not
 * theirs. A hundred refusals for rate is a script, not a crowd.
 */
export const SUGGEST_AFTER_UNAUTHORIZED_ORIGINS = 50;
export const SUGGEST_AFTER_RATE_LIMITED = 100;

export const TURNSTILE_UNAVAILABLE =
  'Turnstile is not set up on this service yet, so it cannot be turned on. Contact support.';

export const suggestTurnstile = ({ enabled, signals }: TurnstileState): boolean =>
  !enabled &&
  (signals.unauthorizedOrigins >= SUGGEST_AFTER_UNAUTHORIZED_ORIGINS ||
    signals.rateLimited >= SUGGEST_AFTER_RATE_LIMITED);

export interface TurnstileSettingsPort {
  readonly read: (tenantId: string) => Promise<TurnstileSettingsResponse>;
  readonly set: (tenantId: string, enabled: boolean) => Promise<TurnstileSettingsResponse>;
}

export interface TurnstileSettingsDeps {
  /** Whether this deployment can verify a token — a site key and a secret are configured. */
  readonly available: boolean;
  readonly audit?: ((tx: DbTransaction, entry: AuditEntry) => Promise<void>) | undefined;
}

const view = (state: TurnstileState, available: boolean): TurnstileSettingsResponse => ({
  enabled: state.enabled,
  available,
  suggested: available && suggestTurnstile(state),
  signals: state.signals,
});

export const createTurnstileSettingsPort = ({
  available,
  audit = auditRow,
}: TurnstileSettingsDeps): TurnstileSettingsPort => ({
  read: async (tenantId) =>
    view(await withTenant(tenantId, (tx) => readTurnstileState(tx)), available),

  set: async (tenantId, enabled) => {
    /*
     * Refused before the transaction: turning on a challenge this deployment
     * cannot verify would refuse every visitor's session. Turning it *off* is
     * always allowed — that is the way out of that state, whatever caused it.
     */
    if (enabled && !available) throw new ConflictError(TURNSTILE_UNAVAILABLE);

    const state = await withTenant(tenantId, async (tx) => {
      await setTurnstileEnabled(tx, enabled);

      /* On the change's own transaction (P0-53). */
      await audit(tx, {
        action: enabled ? 'widget.turnstile_enabled' : 'widget.turnstile_disabled',
        target: `tenant:${tenantId}`,
      });

      return readTurnstileState(tx);
    });

    return view(state, available);
  },
});

export class TurnstileSettingsNotConfiguredError extends Error {
  constructor() {
    super(
      'No Turnstile settings port was supplied to createApp. This is a wiring bug at the ' +
        'composition root, not a request problem.',
    );
    this.name = 'TurnstileSettingsNotConfiguredError';
  }
}

export const unconfiguredTurnstileSettings: TurnstileSettingsPort = {
  read: () => Promise.reject(new TurnstileSettingsNotConfiguredError()),
  set: () => Promise.reject(new TurnstileSettingsNotConfiguredError()),
};
