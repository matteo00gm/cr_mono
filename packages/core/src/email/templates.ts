import { render, type Block, type RenderedEmail } from './render.js';

/**
 * The six transactional templates (P0-64), in Italian and English.
 *
 * **Not React Email**, and the row says why: it would pull React into a
 * repository that deliberately runs one UI runtime, Preact (§Repository
 * Layout). For six templates a typed function returning blocks costs less and
 * leaves that decision intact. The threshold for revisiting is written down —
 * past a dozen templates, or the first time a non-engineer needs to edit the
 * copy — so this is a choice with an expiry rather than a preference.
 *
 * Italian is first in every pair because the customers are Italian wine
 * sellers. English exists for the operators and for sellers who ask.
 */

export const LOCALES = ['it', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Every template and the props it needs.
 *
 * The map is what makes `sendEmail` typed end to end: naming a template fixes
 * the props, so a renamed field is a compile error at the call site rather than
 * `undefined` interpolated into mail a customer receives.
 */
export interface TemplateProps {
  invite: {
    readonly tenantName: string;
    readonly inviterEmail: string;
    readonly acceptUrl: string;
    readonly expiresInDays: number;
  };
  'password-reset': {
    readonly resetUrl: string;
    readonly expiresInMinutes: number;
  };
  'quota-warning': {
    readonly tenantName: string;
    readonly usedPercent: number;
    readonly periodEndsOn: string;
    readonly upgradeUrl: string;
  };
  'quota-exhausted': {
    readonly tenantName: string;
    readonly periodEndsOn: string;
    readonly upgradeUrl: string;
  };
  'trial-expiry': {
    readonly tenantName: string;
    readonly daysLeft: number;
    readonly upgradeUrl: string;
  };
  'domain-claim': {
    readonly tenantName: string;
    readonly domain: string;
    readonly manageUrl: string;
  };
}

export type TemplateName = keyof TemplateProps;

export const TEMPLATE_NAMES = [
  'invite',
  'password-reset',
  'quota-warning',
  'quota-exhausted',
  'trial-expiry',
  'domain-claim',
] as const satisfies readonly TemplateName[];

interface Content {
  readonly subject: string;
  readonly blocks: readonly Block[];
}

/** Both locales, always. The type is what stops one being forgotten. */
type Copy<P> = Readonly<Record<Locale, (props: P) => Content>>;

/* -------------------------------------------------------------------------- */

const invite: Copy<TemplateProps['invite']> = {
  it: (p) => ({
    subject: `${p.tenantName}: invito ad AI Sommelier`,
    blocks: [
      { kind: 'text', value: `${p.inviterEmail} ti ha invitato a collaborare su ${p.tenantName}.` },
      { kind: 'action', label: 'Accetta l’invito', url: p.acceptUrl },
      {
        kind: 'note',
        value:
          `Il link scade fra ${String(p.expiresInDays)} giorni e può essere usato una sola volta. ` +
          'Se non aspettavi questo invito, ignora il messaggio: senza il link non succede nulla.',
      },
    ],
  }),
  en: (p) => ({
    subject: `${p.tenantName}: you have been invited to AI Sommelier`,
    blocks: [
      { kind: 'text', value: `${p.inviterEmail} invited you to work on ${p.tenantName}.` },
      { kind: 'action', label: 'Accept the invitation', url: p.acceptUrl },
      {
        kind: 'note',
        value:
          `The link expires in ${String(p.expiresInDays)} days and works once. ` +
          'If you were not expecting this, ignore the message — nothing happens without the link.',
      },
    ],
  }),
};

/*
 * The one template where deliverability is not a quality concern but the
 * product working at all: a reset mail in the spam folder is a paying customer
 * with no self-service way back into their account (§P0-45).
 */
const passwordReset: Copy<TemplateProps['password-reset']> = {
  it: (p) => ({
    subject: 'Reimposta la tua password',
    blocks: [
      { kind: 'text', value: 'Hai chiesto di reimpostare la password del tuo account.' },
      { kind: 'action', label: 'Reimposta la password', url: p.resetUrl },
      {
        kind: 'note',
        value:
          `Il link scade fra ${String(p.expiresInMinutes)} minuti. ` +
          'Se non sei stato tu, non devi fare nulla: la password attuale resta valida.',
      },
    ],
  }),
  en: (p) => ({
    subject: 'Reset your password',
    blocks: [
      { kind: 'text', value: 'You asked to reset the password on your account.' },
      { kind: 'action', label: 'Reset your password', url: p.resetUrl },
      {
        kind: 'note',
        value:
          `The link expires in ${String(p.expiresInMinutes)} minutes. ` +
          'If this was not you, there is nothing to do — your current password still works.',
      },
    ],
  }),
};

const quotaWarning: Copy<TemplateProps['quota-warning']> = {
  it: (p) => ({
    subject: `${p.tenantName}: hai usato l’${String(p.usedPercent)}% delle conversazioni incluse`,
    blocks: [
      {
        kind: 'text',
        value:
          `${p.tenantName} ha usato l’${String(p.usedPercent)}% delle conversazioni incluse nel piano. ` +
          `Il periodo si chiude il ${p.periodEndsOn}.`,
      },
      { kind: 'action', label: 'Vedi i consumi', url: p.upgradeUrl },
      {
        kind: 'note',
        value: 'Ti scriviamo ora, non a quota esaurita, così hai il tempo di decidere.',
      },
    ],
  }),
  en: (p) => ({
    subject: `${p.tenantName}: ${String(p.usedPercent)}% of included conversations used`,
    blocks: [
      {
        kind: 'text',
        value:
          `${p.tenantName} has used ${String(p.usedPercent)}% of the conversations included in its plan. ` +
          `The period ends on ${p.periodEndsOn}.`,
      },
      { kind: 'action', label: 'See usage', url: p.upgradeUrl },
      {
        kind: 'note',
        value: 'We write now rather than at the limit, so there is time to decide.',
      },
    ],
  }),
};

const quotaExhausted: Copy<TemplateProps['quota-exhausted']> = {
  it: (p) => ({
    subject: `${p.tenantName}: conversazioni incluse esaurite`,
    blocks: [
      {
        kind: 'text',
        value:
          `${p.tenantName} ha esaurito le conversazioni incluse. ` +
          `La quota si azzera il ${p.periodEndsOn}; fino ad allora il sommelier risponde ai visitatori ` +
          'con un messaggio di cortesia invece che con un consiglio.',
      },
      { kind: 'action', label: 'Aumenta il piano', url: p.upgradeUrl },
    ],
  }),
  en: (p) => ({
    subject: `${p.tenantName}: included conversations used up`,
    blocks: [
      {
        kind: 'text',
        value:
          `${p.tenantName} has used every conversation included in its plan. ` +
          `The quota resets on ${p.periodEndsOn}; until then the sommelier answers visitors ` +
          'with a courtesy message rather than a recommendation.',
      },
      { kind: 'action', label: 'Increase the plan', url: p.upgradeUrl },
    ],
  }),
};

const trialExpiry: Copy<TemplateProps['trial-expiry']> = {
  it: (p) => ({
    subject: `${p.tenantName}: la prova finisce fra ${String(p.daysLeft)} giorni`,
    blocks: [
      {
        kind: 'text',
        value:
          `La prova di ${p.tenantName} finisce fra ${String(p.daysLeft)} giorni. ` +
          'Il catalogo e le conversazioni restano dove sono: non devi rifare nulla.',
      },
      { kind: 'action', label: 'Scegli un piano', url: p.upgradeUrl },
    ],
  }),
  en: (p) => ({
    subject: `${p.tenantName}: your trial ends in ${String(p.daysLeft)} days`,
    blocks: [
      {
        kind: 'text',
        value:
          `The trial for ${p.tenantName} ends in ${String(p.daysLeft)} days. ` +
          'Your catalogue and conversations stay where they are — nothing has to be set up again.',
      },
      { kind: 'action', label: 'Choose a plan', url: p.upgradeUrl },
    ],
  }),
};

/*
 * Sent to the tenant that already holds a domain when someone else claims it
 * (§3.2). It is a security notice, so it says what happened and what to do —
 * and it goes out whether or not the claim succeeded, because the useful signal
 * is the attempt.
 */
const domainClaim: Copy<TemplateProps['domain-claim']> = {
  it: (p) => ({
    subject: `${p.tenantName}: qualcuno ha richiesto ${p.domain}`,
    blocks: [
      {
        kind: 'text',
        value:
          `Un altro account ha provato a verificare ${p.domain}, che è già collegato a ${p.tenantName}. ` +
          'Il dominio non è stato spostato.',
      },
      { kind: 'action', label: 'Controlla i domini', url: p.manageUrl },
      {
        kind: 'note',
        value:
          'Se sei stato tu, o un tuo collega, non serve fare nulla. ' +
          'Altrimenti scrivici: vuol dire che qualcun altro controlla il DNS di quel dominio.',
      },
    ],
  }),
  en: (p) => ({
    subject: `${p.tenantName}: someone claimed ${p.domain}`,
    blocks: [
      {
        kind: 'text',
        value:
          `Another account tried to verify ${p.domain}, which is already connected to ${p.tenantName}. ` +
          'The domain has not moved.',
      },
      { kind: 'action', label: 'Review your domains', url: p.manageUrl },
      {
        kind: 'note',
        value:
          'If this was you or a colleague, there is nothing to do. ' +
          'If not, reply to this message — it means someone else controls DNS for that domain.',
      },
    ],
  }),
};

const TEMPLATES = {
  invite,
  'password-reset': passwordReset,
  'quota-warning': quotaWarning,
  'quota-exhausted': quotaExhausted,
  'trial-expiry': trialExpiry,
  'domain-claim': domainClaim,
} satisfies { [K in TemplateName]: Copy<TemplateProps[K]> };

/**
 * Renders a template into a subject, an HTML part and a plaintext part.
 *
 * The cast is the one place the map's key/value correspondence has to be
 * asserted rather than inferred: `TEMPLATES[name]` widens to a union of every
 * template's function type, and TypeScript will not narrow that against `props`
 * drawn from a generic parameter. `satisfies` above is what makes the assertion
 * sound — it checks each entry against exactly this correspondence at the
 * definition, which is where the mistake would actually be made.
 */
export const renderTemplate = <K extends TemplateName>(
  name: K,
  props: TemplateProps[K],
  locale: Locale,
): RenderedEmail => {
  const copy = TEMPLATES[name] as Copy<TemplateProps[K]>;
  const content = copy[locale](props);
  return render(content.subject, content.blocks, locale);
};
