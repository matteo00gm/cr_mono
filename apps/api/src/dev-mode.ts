import {
  audit,
  DEV_MODE_HOURS,
  DEV_MODE_LOCAL_ONLY,
  InvalidRequestError,
  localOrigin,
} from '@catalogorosso/core';
import type { DevModeResponse } from '@catalogorosso/api-client';
import {
  enableDevMode,
  endDevMode,
  endSessionsFor,
  readDevMode,
  withTenant,
  type DevMode,
} from '@catalogorosso/db';

/**
 * Development mode (P4-19b): the widget served to one local origin for a day,
 * so a seller's developer can build against it before it is live.
 *
 * **What makes it safe is in three places, none of them here.** The origin must
 * be local (`localOrigin`, shared with the widget's CORS check); the database
 * will hold nothing else (0058's check); and the tenants policy stops admitting
 * the winery the moment the grant runs out (0059). This port only writes the
 * grant, audits it, and ends it early.
 */

export interface EnableDevModeCommand {
  readonly tenantId: string;
  /** Whatever the developer typed: `localhost:3000`, `http://localhost:3000/`. */
  readonly input: string;
}

export interface DevModePort {
  devMode(tenantId: string): Promise<DevModeResponse>;
  enableDevMode(command: EnableDevModeCommand): Promise<DevModeResponse>;
  endDevMode(tenantId: string): Promise<DevModeResponse>;
}

const toResponse = (grant: DevMode | undefined): DevModeResponse =>
  grant === undefined
    ? { active: false, origin: null, expiresAt: null }
    : { active: true, origin: grant.origin, expiresAt: grant.expiresAt.toISOString() };

export const createDevMode = ({
  audit: record = audit,
}: { readonly audit?: typeof audit } = {}): DevModePort => ({
  async devMode(tenantId) {
    return toResponse(await withTenant(tenantId, readDevMode));
  },

  async enableDevMode(command) {
    const origin = localOrigin(command.input);

    if (origin === undefined) throw new InvalidRequestError(DEV_MODE_LOCAL_ONLY);

    const grant = await withTenant(command.tenantId, async (tx) => {
      const previous = await readDevMode(tx);
      const started = await enableDevMode(tx, origin, DEV_MODE_HOURS);

      /*
       * A grant moved to another port ends the sessions on the old one, as a
       * removed domain's are (P4-06): an origin that stopped being allowed
       * should not keep a conversation going on a token minted before.
       */
      if (previous !== undefined && previous.origin !== origin) {
        await endSessionsFor(tx, previous.origin);
      }

      await record(tx, { action: 'widget.dev_mode_enabled', target: origin });

      return started;
    });

    return toResponse(grant);
  },

  async endDevMode(tenantId) {
    await withTenant(tenantId, async (tx) => {
      const origin = await endDevMode(tx);

      if (origin !== undefined) {
        await endSessionsFor(tx, origin);
        await record(tx, { action: 'widget.dev_mode_ended', target: origin });
      }
    });

    return toResponse(undefined);
  },
});
