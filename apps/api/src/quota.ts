import { CHAT_MESSAGE, checkQuota, periodOf, type QuotaDecision } from '@catalogorosso/core';
import { countUsage, withTenant } from '@catalogorosso/db';
import { planCapCheck, tenantOfPlanCap, type MonthlyCheck } from '@catalogorosso/security';

import type { WidgetTenant } from './env.js';

/**
 * Reading the month, and refusing past it (P2-36, §3.6).
 *
 * **The ledger is the source of truth, not the limiter's bucket.** A plan sells
 * messages, `usage_events` holds one row per message that was actually billed,
 * and that is the number a seller's invoice and §2.3's banner are built from.
 * A count kept anywhere else is a second answer to the same question.
 *
 * **It is an indexed equality on `(tenant_id, period)`**, which is what the
 * column's `YYYYMM` shape exists for: this runs before every model call.
 */

/**
 * Properties holding functions, not method signatures.
 *
 * The composition root hands `quota.readUsage` to the widget dependencies as a
 * value, and a method detached from its object is exactly what
 * `@typescript-eslint/unbound-method` exists to refuse. Declaring them this way
 * says, in the type, that neither reads `this`.
 */
export interface QuotaPort {
  /** How much of the month a check's tenant has spent. Reads, never consumes. */
  readonly readUsage: (check: MonthlyCheck) => Promise<number>;
  /** Messages a tenant bought on top of its plan this month (P5-11a). */
  readonly readPurchased: (tenantId: string) => Promise<number>;
  /** Whether one more message may be answered by this tenant. */
  readonly check: (tenant: WidgetTenant) => Promise<QuotaDecision>;
}

export interface QuotaPortOptions {
  /** The clock the period is read from. Injected so a test can cross a month boundary. */
  readonly now?: () => Date;
  /**
   * Messages bought on top of the plan for a period (P5-11a's ledger). Until
   * there is one, nothing can be bought, and nought is the true answer — the
   * restrictive one too, since it is the plan's cap and nothing more.
   */
  readonly readPurchased?: ((tenantId: string, period: string) => Promise<number>) | undefined;
}

export const createQuotaPort = ({
  now = () => new Date(),
  readPurchased = () => Promise.resolve(0),
}: QuotaPortOptions = {}): QuotaPort => {
  const purchased = (tenantId: string): Promise<number> => readPurchased(tenantId, periodOf(now()));

  const used = (tenantId: string): Promise<number> =>
    withTenant(tenantId, (tx) => countUsage(tx, periodOf(now()), CHAT_MESSAGE));

  return {
    readUsage: async (check) => {
      const tenantId = tenantOfPlanCap(check.key);

      /*
       * A key that is not a plan cap has no month to read. Nought rather than a
       * throw, because the only caller is the config route's banner and a
       * banner is not worth failing a request over — and the gate below never
       * takes this path.
       */
      return tenantId === undefined ? 0 : await used(tenantId);
    },

    readPurchased: purchased,

    /*
     * **The plan's messages plus what was bought, compared against the
     * ledger** (P5-11). A top-up raises this and the limiter's bucket by the
     * same number, through the one `planCapCheck`, so a message bought is a
     * message served.
     */
    check: async (tenant) => {
      const [spent, bought] = await Promise.all([
        used(tenant.tenantId),
        purchased(tenant.tenantId),
      ]);
      const cap = planCapCheck(tenant.tenantId, tenant.plan, bought);

      return checkQuota({ used: spent, limit: cap.limit });
    },
  };
};
