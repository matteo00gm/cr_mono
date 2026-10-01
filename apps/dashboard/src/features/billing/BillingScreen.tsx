import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { ApiError, type ApiClient, type UsageResponse } from '@catalogorosso/api-client';
import { PLAN_IDS, PLANS, type PlanId } from '@catalogorosso/core/plans';

import { StepUpPrompt } from '../security/StepUpPrompt.js';
import { needsStepUp, type TwoFactorApi } from '../security/two-factor.js';
import { count, euros, nextPlan, resetDay, TOP_UP_LABEL, upgradeLabel } from './billing-copy.js';

/**
 * Fatturazione (P5-12, §2.3, §2.5): the month's messages against what the
 * winery may send, where it is heading, and every way to change it — a
 * top-up, another plan, the payment method.
 *
 * **Nothing here decides anything.** Every button asks the API, which holds
 * the rules (P5-09, P5-10, P5-11a) and answers with a page to send the owner
 * to, or a refusal whose words are the API's own. A purchase is finished on
 * Stripe's page; this screen only says what Stripe will be asked.
 */

/** The meter (§2.3): used against the allowance, and the month at this rate. */
export const UsageMeter = ({ usage }: { readonly usage: UsageResponse }): JSX.Element => (
  <section class="cr-meter" aria-label="Messaggi del mese">
    <p class="cr-meter__figure">
      <strong>{count(usage.used)}</strong> di {count(usage.allowance)} messaggi usati questo mese
    </p>
    <meter
      class="cr-meter__bar"
      min={0}
      max={usage.allowance}
      low={Math.floor(usage.allowance * 0.8)}
      high={usage.allowance}
      optimum={0}
      value={usage.used}
      aria-label="Messaggi usati"
    />
    <p class="cr-meter__note">
      Proiezione a fine mese: {count(usage.projected)}. Si azzerano il {resetDay(usage.resetsAt)}.
      {usage.purchased > 0 ? ` Comprende ${count(usage.purchased)} messaggi da ricariche.` : ''}
    </p>
  </section>
);

const Breakdown = ({ usage }: { readonly usage: UsageResponse }): JSX.Element | null =>
  usage.byDay.length === 0 ? null : (
    <section class="cr-breakdown" aria-label="Dove sono andati i messaggi">
      <table>
        <caption>Per giorno</caption>
        <tbody>
          {usage.byDay.map((day) => (
            <tr key={day.day}>
              <th scope="row">{day.day}</th>
              <td>{count(day.messages)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table>
        <caption>Per sito</caption>
        <tbody>
          {usage.byOrigin.map((origin) => (
            <tr key={origin.origin ?? ''}>
              <th scope="row">{origin.origin ?? 'Senza sito'}</th>
              <td>{count(origin.messages)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

/** What Stripe sent the owner back with, said plainly. */
const RETURNED: Readonly<Record<string, string>> = {
  'checkout=success': 'Grazie: il piano si attiva appena Stripe conferma il pagamento.',
  'top_up=success': 'Grazie: i messaggi si aggiungono appena Stripe conferma il pagamento.',
};

const returnNote = (search: string): string | undefined =>
  Object.entries(RETURNED).find(([key]) => search.includes(key))?.[1];

export const BillingScreen = ({
  client,
  go = (url) => {
    globalThis.location.assign(url);
  },
  search = globalThis.location.search,
  twoFactor,
}: {
  readonly client: ApiClient;
  /** Where a purchase continues: Stripe's page. Injected so a test can see it. */
  readonly go?: ((url: string) => void) | undefined;
  readonly search?: string | undefined;
  /** The step-up's verifier (P4-11). Injected so a test can be the authenticator. */
  readonly twoFactor?: TwoFactorApi | undefined;
}): JSX.Element => {
  const [usage, setUsage] = useState<UsageResponse | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>(() => returnNote(search));
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState<(() => Promise<void>) | undefined>();

  useEffect(() => {
    let live = true;

    client
      .request('GET /v1/dashboard/usage')
      .then((answer) => {
        if (live) setUsage(answer);
      })
      .catch(() => {
        if (live) setFailure('Non è stato possibile leggere i consumi. Riprova fra un momento.');
      });

    return () => {
      live = false;
    };
  }, [client]);

  /**
   * Runs one action, asking for a fresh second factor when the API wants one
   * (P4-11) and then trying the same action again — nothing else.
   */
  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setFailure(undefined);

    try {
      await action();
    } catch (error) {
      if (needsStepUp(error)) {
        setRetry(() => action);
      } else {
        setFailure(
          error instanceof ApiError
            ? error.message
            : 'Non è stato possibile completare l’operazione. Riprova fra un momento.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const checkout = (plan: PlanId) => async () => {
    go((await client.request('POST /v1/dashboard/billing/checkout', { body: { plan } })).url);
  };

  const changePlan = (plan: PlanId) => async () => {
    const changed = await client.request('POST /v1/dashboard/billing/plan', { body: { plan } });

    setNotice(
      changed.effective === 'now'
        ? `Passaggio a ${PLANS[plan].name} richiesto: i nuovi limiti valgono appena Stripe conferma.`
        : `Passaggio a ${PLANS[plan].name} programmato: avviene il ${resetDay(
            changed.effectiveAt ?? usage?.resetsAt ?? new Date().toISOString(),
          )}.`,
    );
  };

  const topUp = async () => {
    go((await client.request('POST /v1/dashboard/billing/top-up')).url);
  };

  const portal = async () => {
    go((await client.request('POST /v1/dashboard/billing/portal')).url);
  };

  if (usage === undefined) {
    return (
      <section>
        <h1>Fatturazione</h1>
        {failure === undefined ? (
          <p aria-busy="true">Caricamento…</p>
        ) : (
          <p role="alert">{failure}</p>
        )}
      </section>
    );
  }

  const upgrade = usage.plan === null ? undefined : nextPlan(usage.plan);
  const lower = PLAN_IDS.filter(
    (plan) => usage.plan !== null && PLAN_IDS.indexOf(plan) < PLAN_IDS.indexOf(usage.plan),
  );

  return (
    <section class="cr-billing">
      <h1>Fatturazione</h1>

      {notice === undefined ? null : <p role="status">{notice}</p>}
      {failure === undefined ? null : <p role="alert">{failure}</p>}

      <UsageMeter usage={usage} />

      <section id="ricarica" aria-label="Ricarica">
        {usage.plan !== null && usage.status === 'ACTIVE' ? (
          <button type="button" disabled={busy} onClick={() => void act(topUp)}>
            {TOP_UP_LABEL}
          </button>
        ) : null}
      </section>

      <section id="piano" aria-label="Piano">
        {usage.plan === null ? (
          <>
            <h2>Scegli un piano</h2>
            {PLAN_IDS.map((plan) => (
              <button
                key={plan}
                type="button"
                disabled={busy}
                onClick={() => void act(checkout(plan))}
              >
                {`${PLANS[plan].name} — ${euros(PLANS[plan].amountCents)}/mese, ${count(PLANS[plan].messagesPerMonth)} messaggi`}
              </button>
            ))}
          </>
        ) : (
          <>
            <h2>
              Piano {PLANS[usage.plan].name} — {euros(PLANS[usage.plan].amountCents)}/mese
            </h2>
            {upgrade === undefined ? null : (
              <button type="button" disabled={busy} onClick={() => void act(changePlan(upgrade))}>
                {upgradeLabel(upgrade)}
              </button>
            )}
            {lower.map((plan) => (
              <button
                key={plan}
                type="button"
                disabled={busy}
                onClick={() => void act(changePlan(plan))}
              >
                {`Passa al piano ${PLANS[plan].name} dal prossimo rinnovo`}
              </button>
            ))}
            <button type="button" disabled={busy} onClick={() => void act(portal)}>
              Gestisci pagamento e fatture
            </button>
          </>
        )}
      </section>

      <Breakdown usage={usage} />

      {retry === undefined ? null : (
        <StepUpPrompt
          api={twoFactor}
          onVerified={() => {
            const again = retry;

            setRetry(undefined);
            void act(again);
          }}
          onCancel={() => {
            setRetry(undefined);
          }}
        />
      )}
    </section>
  );
};
