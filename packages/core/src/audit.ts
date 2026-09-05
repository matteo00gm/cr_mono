import { insertAuditRow, type DbTransaction } from '@catalogorosso/db';
import { redactValue } from '@catalogorosso/security';

import { getRequestActor } from './request-context.js';

/**
 * The `audit_log` writer (P0-53).
 *
 * One helper so every sensitive action records the same shape. Without it each
 * caller invents its own column set, and the log becomes a thing you have to
 * read the calling code to interpret — which is the opposite of what an audit
 * log is for.
 */

export interface AuditEntry {
  /**
   * What happened, as free text: `member.removed`, `domain.added`.
   *
   * The column is deliberately not an enum (P0-31): an audit log has to record
   * an action added next week without a migration, because a schema change on
   * the write path is exactly the friction that makes people log nothing.
   */
  readonly action: string;
  /** What it happened to — a domain, a membership, a key. */
  readonly target?: string | undefined;
  /** Action-shaped detail: the old and new value, the thing removed. */
  readonly metadata?: Record<string, unknown> | undefined;
}

export class MissingAuditTenantError extends Error {
  constructor(action: string) {
    super(
      `Cannot audit "${action}" with no tenant in the request context. ` +
        'audit() runs inside withTenant, which resolves the tenant before any ' +
        'action it audits — so this means the write is happening outside a ' +
        'request, or before tenant resolution ran.',
    );
    this.name = 'MissingAuditTenantError';
  }
}

/**
 * Records an audited action.
 *
 * **Takes the caller's transaction**, and that is the whole design. The audit
 * row commits or rolls back with the action it describes — an entry for
 * something that did not happen is worse than no entry, because it is a record
 * people will believe. A helper that opened its own connection would produce
 * exactly that on every failed action.
 *
 * The actor, ip and user-agent come from the request context rather than from
 * arguments, for the same reason the logger does not take a logger: the one
 * call site nobody threaded them into is the one that matters. They are read
 * *here* rather than captured earlier, because the user is only known after
 * authentication and the tenant only after resolution.
 *
 * **Metadata is redacted before it is written**, through the same allowlist the
 * logs use (P0-56). Callers pass whatever describes the action, and "whatever"
 * is how a reset token or an API key ends up in a table that is append-only by
 * design — with no way to take it out again short of dropping the tenant.
 */
export const audit = async (tx: DbTransaction, entry: AuditEntry): Promise<void> => {
  const actor = getRequestActor();

  if (actor.tenantId === undefined) throw new MissingAuditTenantError(entry.action);

  const metadata =
    entry.metadata === undefined ? undefined : JSON.stringify(redactValue(entry.metadata));

  await insertAuditRow(tx, {
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    action: entry.action,
    target: entry.target,
    metadata,
    ip: actor.ip,
    userAgent: actor.userAgent,
  });
};
