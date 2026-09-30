import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { ApiClient, ServedClaim } from '@catalogorosso/api-client';

/**
 * The banner a winery sees when somebody has claimed one of its domains
 * (P4-18b).
 *
 * **The second of the two ways a holder is told**, beside the mail the claim
 * sweep sends — and the one that works when the mail went to an owner who has
 * left. It says which domain, when it moves, and offers the one thing to do if
 * the domain is still theirs: withdraw the claim, in one click, as the plan
 * promises. Nothing about the claimant, because the API returns nothing.
 *
 * **It fails quietly.** A banner that could not load is a banner not shown;
 * the mail is still on its way, and an error box across the top of every screen
 * for a feature most wineries never meet would be worse than its absence.
 */

/** The deadline as a seller reads it: Italian, in Italian time. */
export const formatTransfer = (iso: string): string =>
  new Intl.DateTimeFormat('it-IT', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Rome',
  }).format(new Date(iso));

export const ClaimNotice = ({ client }: { readonly client: ApiClient }): JSX.Element | null => {
  const [claims, setClaims] = useState<readonly ServedClaim[]>([]);
  const [busy, setBusy] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | undefined>();

  useEffect(() => {
    let live = true;

    client
      .request('GET /v1/dashboard/domains/claims/served')
      .then((answer) => {
        if (live) setClaims(answer.claims);
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [client]);

  if (claims.length === 0) return null;

  const withdraw = async (id: string): Promise<void> => {
    setBusy(id);
    setFailure(undefined);

    try {
      await client.request('POST /v1/dashboard/domains/claims/:id/withdraw', { params: { id } });
      setClaims((current) => current.filter((claim) => claim.id !== id));
    } catch {
      setFailure('Non è stato possibile ritirare la richiesta. Riprova fra un momento.');
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section class="shell-notice shell-claims" role="alert" aria-label="Richieste sui tuoi domini">
      {claims.map((claim) => (
        <p key={claim.id}>
          Un altro account ha dimostrato di controllare il DNS di <strong>{claim.origin}</strong> e
          ne ha chiesto il trasferimento. Se non ritiri la richiesta, il dominio passerà a
          quell’account il {formatTransfer(claim.transferAt)} e il widget smetterà di funzionare lì.{' '}
          <button
            type="button"
            disabled={busy === claim.id}
            onClick={() => {
              void withdraw(claim.id);
            }}
          >
            Ritira la richiesta
          </button>
        </p>
      ))}
      {failure === undefined ? null : <p class="shell-claims-failure">{failure}</p>}
    </section>
  );
};
