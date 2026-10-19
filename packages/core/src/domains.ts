import { randomBytes } from 'node:crypto';

import type { NormalizeFailure, PlanTier } from '@catalogorosso/security';
import type { DnsFailure, WellKnownFailure } from '@catalogorosso/security/net';

import { PLANS, TRIAL } from './plans.js';

/**
 * What a seller is told when a domain is refused (P4-01, §3.3).
 *
 * **A `DomainError`'s message is the API contract and reaches the caller
 * verbatim** (P0-55), so these are written for the person adding a domain
 * rather than for us. Each one says what was wrong and what to do instead,
 * because "invalid domain" on the one screen a seller must get through before
 * the product works is a support ticket by design.
 *
 * The map is exhaustive over `NormalizeFailure` by type, so a reason added to
 * P2-05 fails the build here rather than falling through to a generic string —
 * which is the failure mode that produces "invalid domain" in the first place.
 */
const REFUSALS: Record<NormalizeFailure, string> = {
  invalid_url: 'Non sembra un dominio. Scrivilo come cantina.it oppure www.cantina.it.',
  not_https:
    'Si possono aggiungere solo domini https. Il tuo sito deve essere servito in https prima che il widget possa funzionarci.',
  ip_literal:
    'Un indirizzo IP non può essere verificato come dominio. Scrivi il nome con cui il tuo sito è raggiungibile.',
  public_suffix:
    'Questo è un suffisso, non un dominio. Scrivi il nome completo, per esempio cantina.it.',
  single_label: 'A un dominio serve un suffisso. Scrivi cantina.it, non cantina.',
  has_path:
    'Scrivi solo il dominio, senza percorso. Il widget è ammesso su tutte le pagine di un dominio verificato.',
  localhost:
    'localhost non può essere verificato. Aggiungi il dominio su cui il tuo sito è pubblicato.',
};

export const refusalMessage = (reason: NormalizeFailure): string => REFUSALS[reason];

/**
 * What an origin somebody else already holds is answered with.
 *
 * **Generic on purpose, and the generality is the security property** (§3.2).
 * "That origin belongs to another tenant" confirms a competitor is a customer,
 * and repeated against a list of domains it enumerates our customer base. This
 * message is the same one an origin the seller has mistyped would get.
 *
 * It points at the claim (P4-18) rather than at support, because proving DNS
 * control is the answer for a seller who really does own it — and offering it
 * to everybody says nothing about whether anybody holds the origin.
 */
export const ORIGIN_UNAVAILABLE =
  'Questo dominio non può essere aggiunto. Se è tuo, puoi rivendicarlo dimostrando di ' +
  'controllarne il DNS.';

/**
 * A verification nonce.
 *
 * 32 bytes from the CSPRNG, hex. It is published — in DNS or in a file at a
 * URL — so its only job is to be unguessable: a seller who could predict the
 * nonce another seller will be issued could stage the proof before the claim.
 *
 * Expiry and single use are P4-04's; this is the generator both halves share.
 */
export const verificationToken = (): string => randomBytes(32).toString('hex');

/**
 * How many domains a plan includes (P4-07).
 *
 * **Counted across `PENDING` and `VERIFIED` together**, because a pending claim
 * holds the origin against every other winery on the platform (§3.2) — so a cap
 * that ignored them would let a seller hold any number of origins simply by
 * never finishing the verification.
 *
 * `none` is a tenant that has not chosen a plan yet, which every tenant is
 * between signup and checkout. It gets the entry allowance rather than nought:
 * a seller who cannot add the one domain they came to add cannot try the
 * product at all, and this is the screen that gates everything else.
 */
export const DOMAIN_CAPS: Readonly<Record<PlanTier, number>> = {
  CANTINA: PLANS.CANTINA.productionDomains,
  ECOMMERCE: PLANS.ECOMMERCE.productionDomains,
  none: TRIAL.productionDomains,
};

/**
 * What a seller calls what they are on, which is not what the enum calls it —
 * and a winery that has bought nothing is on a free trial, not on a plan.
 */
const PLAN_NAMES: Readonly<Record<PlanTier, string>> = {
  CANTINA: `Il tuo piano ${PLANS.CANTINA.name}`,
  ECOMMERCE: `Il tuo piano ${PLANS.ECOMMERCE.name}`,
  none: 'La tua prova gratuita',
};

export const capFor = (plan: PlanTier): number => DOMAIN_CAPS[plan];

/**
 * What a seller at their cap is told.
 *
 * **Names the plan, the number, and where to change it.** A bare "limit
 * reached" on the screen that gates the whole product is a support ticket, and
 * a seller who cannot tell whether they are one domain short or on the wrong
 * plan has no way to act on it.
 */
export const capMessage = (plan: PlanTier, cap: number): string =>
  `${PLAN_NAMES[plan]} comprende ${String(cap)} ${cap === 1 ? 'dominio' : 'domini'}, ` +
  `${cap === 1 ? 'ed è già in uso' : 'e sono tutti in uso'}. Rimuovine uno che non usi più, oppure ` +
  'cambia piano nella schermata Fatturazione.';

/**
 * How many staging origins a winery may hold, whatever its plan (P4-19).
 *
 * **Outside the plan's domain cap**, because charging a seller a domain slot to
 * test is a bad trade for us: it discourages testing, and an untested install
 * is a support ticket. Two is a staging site and a preview; a third is a second
 * production site under another name.
 */
export const STAGING_DOMAIN_CAP = 2;

export const STAGING_CAP_MESSAGE =
  `Puoi avere fino a ${String(STAGING_DOMAIN_CAP)} domini di prova, e sono entrambi in uso. ` +
  'Rimuovine uno su cui non fai più prove.';

/**
 * Whether a registrable domain is a Shopify store's own `*.myshopify.com`
 * (P4-19).
 *
 * `myshopify.com` is a public suffix, so every store is its own registrable
 * domain — and Shopify controls that zone, so a seller can neither publish a
 * TXT record there nor put a file at its root. Neither proof can ever succeed,
 * and saying so up front beats a check that fails with no explanation.
 */
export const isShopifyStoreDomain = (registrableDomain: string): boolean =>
  registrableDomain.endsWith('.myshopify.com');

export const SHOPIFY_UNVERIFIABLE =
  'Un indirizzo myshopify.com non può essere verificato con il DNS o con un file, perché lo ' +
  'controlla Shopify. Collega invece il tuo negozio Shopify da Integrazioni: il collegamento ' +
  'lo verifica e lo aggiunge per te.';

/**
 * How often one domain may be re-checked (P4-02, P2-04).
 *
 * **This endpoint makes an outbound network call on demand**, which makes it an
 * amplification vector: without a limit, an owner with one domain can drive as
 * many DNS lookups from our address as they like, at somebody else's
 * nameservers.
 *
 * Ten in ten minutes is set against what a seller legitimately does. DNS
 * propagation is slow and uneven, so the honest behaviour is to publish the
 * record and press the button a few times over a quarter of an hour — and a
 * limit tight enough to catch that is a limit that teaches sellers the product
 * is broken.
 */
export const VERIFY_ATTEMPTS = 10;
export const VERIFY_WINDOW_SEC = 600;

/** The bucket a domain's verification attempts are counted in. */
export const verifyLimitKey = (domainId: string): string => `domain-verify:${domainId}`;

/**
 * What a seller is told when a domain did not verify.
 *
 * **"Not found" and "does not match" send them to different places**, and
 * giving the wrong one is how somebody spends an afternoon re-checking DNS they
 * already got right. The third is ours, not theirs, and says so.
 */
const DNS_REFUSALS: Readonly<Record<DnsFailure, string>> = {
  no_record:
    'Non abbiamo trovato il record TXT. Il DNS può impiegare qualche minuto a propagarsi: pubblicalo, poi riprova.',
  mismatch:
    'Abbiamo trovato un record TXT con quel nome, ma non contiene il valore che ti abbiamo dato. Copia il valore qui sotto esattamente, senza virgolette.',
  resolver_error:
    'Non siamo riusciti a completare la ricerca DNS. È un problema nostro, non del tuo record: riprova fra un momento.',
};

export const dnsRefusalMessage = (reason: DnsFailure): string => DNS_REFUSALS[reason];

/** A failed check is worth retrying by the seller; ours is worth retrying by us. */
export const isOurFault = (reason: DnsFailure): boolean => reason === 'resolver_error';

/**
 * What a seller is told when the file check did not pass (P4-03).
 *
 * **`unreachable` is one message for eight different refusals**, and the
 * flattening is deliberate: `guardedFetch`'s reasons name what our network
 * declined to do — an address it would not connect to, a redirect it would not
 * follow — and a caller who could read them could use this endpoint to map our
 * defences. The precise reason goes to the audit log instead.
 */
const WELL_KNOWN_REFUSALS: Readonly<Record<WellKnownFailure, string>> = {
  not_found:
    'Non abbiamo trovato il file. Caricalo esattamente a quel percorso sul tuo sito, poi riprova.',
  mismatch:
    'A quel percorso risponde qualcosa, ma non è il valore che ti abbiamo dato. Il file deve contenere il valore qui sotto e nient’altro: molti siti mostrano una pagina del tema al posto di un errore 404, e l’effetto è questo.',
  unreachable:
    'Non siamo riusciti a raggiungere il tuo sito per controllare. Verifica che sia servito in https sulla porta standard e riprova.',
};

export const wellKnownRefusalMessage = (reason: WellKnownFailure): string =>
  WELL_KNOWN_REFUSALS[reason];

/**
 * What a seller is told when removing their last verified domain (P4-06).
 *
 * **A confirmation, not a refusal.** It is their domain and their decision —
 * what they must not be able to do is make it *by accident*, because the
 * consequence is a widget that stops answering on a live storefront and gives
 * no sign anywhere that somebody turned it off.
 */
export const LAST_DOMAIN_WARNING =
  'È il tuo unico dominio verificato. Rimuovendolo il widget si spegne subito, ovunque sia ' +
  'installato. Conferma la rimozione se è questo che vuoi.';

/** The two proofs a seller may offer, as the API names them. */
export const VERIFY_METHODS = ['dns', 'wellknown'] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];

/** How the choice is recorded on the row. */
export const METHOD_COLUMN: Readonly<Record<VerifyMethod, 'DNS_TXT' | 'WELL_KNOWN'>> = {
  dns: 'DNS_TXT',
  wellknown: 'WELL_KNOWN',
};

/**
 * The other spelling of an origin — apex to `www`, or `www` back to apex
 * (P4-05, §3.3).
 *
 * **The `www` mismatch is otherwise the most common support ticket there is**,
 * and it presents as "the widget doesn't work" with nothing visible anywhere to
 * explain it: the seller verified `winery.com`, their storefront redirects to
 * `www.winery.com`, and the browser sends an `Origin` the allowlist has never
 * heard of.
 *
 * `undefined` when there is no sibling to make. `shop.winery.com` is not an
 * apex and `www.shop.winery.com` is not a spelling of it — both are ordinary
 * subdomains that a seller adds deliberately, and inventing a `www` for every
 * one of them would expand an allowlist nobody asked to expand.
 */
export const siblingOrigin = (origin: string, registrableDomain: string): string | undefined => {
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }

  /* Scheme and port carry over: `http://winery.com:3000` and its `www` are the
   * same pair, and a sibling on a different port would be a different origin. */
  const suffix = url.port === '' ? '' : `:${url.port}`;
  const at = (host: string): string => `${url.protocol}//${host}${suffix}`;

  if (url.hostname === registrableDomain) return at(`www.${registrableDomain}`);
  if (url.hostname === `www.${registrableDomain}`) return at(registrableDomain);

  return undefined;
};

/*
 * The tag a seller pastes (P4-08) and where the loader is (P6-09) live in
 * `install-snippet.ts`, which imports nothing, so the dashboard can build the
 * same tag the theme extension is held to (P4-09b).
 */
export { installSnippet, LOADER_SRC } from './install-snippet.js';
