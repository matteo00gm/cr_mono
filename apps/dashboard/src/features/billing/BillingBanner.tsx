import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Link } from 'wouter-preact';

import type { ApiClient, UsageResponse } from '@catalogorosso/api-client';
import type { Role } from '@catalogorosso/security';

import { nextPlan, resetDay, TOP_UP_LABEL, upgradeLabel } from './billing-copy.js';

/**
 * The banner across every screen when the widget is at risk or already quiet
 * (P5-12, §2.3, §2.5): a failed payment, a month nearly spent, a month spent.
 *
 * **What a role can do decides what it is shown.** An owner gets the ways out
 * as links to their buttons on the Fatturazione screen; an editor, who cannot
 * buy anything, is told what is happening and asked to tell an owner — the
 * same facts, without buttons that would only refuse them.
 *
 * **It fails quietly**, as the claim banner does: a banner that could not load
 * is a banner not shown, and the owners have the email.
 */

const OwnerWaysOut = ({ usage }: { readonly usage: UsageResponse }): JSX.Element => {
  const upgrade = nextPlan(usage.plan);

  return (
    <span class="cr-banner__actions">
      {usage.plan === null ? null : <Link href="/fatturazione#ricarica">{TOP_UP_LABEL}</Link>}
      {upgrade === undefined ? null : (
        <Link href="/fatturazione#piano">{upgradeLabel(upgrade)}</Link>
      )}
    </span>
  );
};

export const BillingBanner = ({
  client,
  role,
}: {
  readonly client: ApiClient;
  readonly role: Role;
}): JSX.Element | null => {
  const [usage, setUsage] = useState<UsageResponse | undefined>();

  useEffect(() => {
    let live = true;

    client
      .request('GET /v1/dashboard/usage')
      .then((answer) => {
        if (live) setUsage(answer);
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [client]);

  if (usage === undefined) return null;

  const owner = role === 'OWNER';

  /* §2.5: the widget is already off. The fix first, then the diagnosis. */
  if (usage.status === 'PAST_DUE') {
    return (
      <section class="cr-banner cr-banner--critical" role="alert" aria-label="Pagamento">
        <p>
          Il pagamento non è riuscito e il widget è disattivato.{' '}
          {owner ? (
            <>
              Aggiorna il metodo di pagamento per riattivarlo subito.{' '}
              <Link href="/fatturazione">Aggiorna il pagamento</Link>
            </>
          ) : (
            'Avvisa un titolare della cantina: solo lui può aggiornare il pagamento.'
          )}
        </p>
      </section>
    );
  }

  if (usage.state === 'exceeded') {
    return (
      <section class="cr-banner cr-banner--critical" role="alert" aria-label="Messaggi del mese">
        <p>
          I messaggi del mese sono finiti: il sommelier non risponde ai visitatori fino al{' '}
          {resetDay(usage.resetsAt)}.{' '}
          {owner ? (
            <OwnerWaysOut usage={usage} />
          ) : (
            'Avvisa un titolare della cantina: può acquistare una ricarica o passare a un piano superiore.'
          )}
        </p>
      </section>
    );
  }

  if (usage.state === 'near') {
    return (
      <section class="cr-banner cr-banner--warning" role="status" aria-label="Messaggi del mese">
        <p>
          Hai usato l’{String(Math.floor((usage.used / usage.allowance) * 100))}% dei messaggi del
          mese.{' '}
          {owner ? (
            <OwnerWaysOut usage={usage} />
          ) : (
            'Avvisa un titolare della cantina prima che finiscano.'
          )}
        </p>
      </section>
    );
  }

  return null;
};
