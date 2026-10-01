import { describe, expect, it } from 'vitest';

import { escapeHtml, UnsafeEmailUrlError } from '../../src/email/render.js';
import {
  LOCALES,
  TEMPLATE_NAMES,
  renderTemplate,
  type Locale,
  type TemplateName,
  type TemplateProps,
} from '../../src/email/templates.js';

/**
 * The templates, in both locales (P0-64).
 *
 * The loop is the point. Asserting one template by hand tests that template;
 * asserting every name in `TEMPLATE_NAMES` against every locale in `LOCALES`
 * tests the *rule* — and a seventh template added next month is covered the
 * moment it is added rather than when someone remembers to write a case for it.
 */

/** One set of props per template, with something hostile in every free-text field. */
const PROPS: { [K in TemplateName]: TemplateProps[K] } = {
  invite: {
    tenantName: 'Cantina <script>alert(1)</script>',
    inviterEmail: 'anna@cantina.example',
    acceptUrl: 'https://app.example/invite/abc',
    expiresInDays: 7,
  },
  'password-reset': {
    resetUrl: 'https://app.example/reset/xyz',
    expiresInMinutes: 30,
  },
  'quota-warning': {
    tenantName: 'Cantina <script>alert(1)</script>',
    usedPercent: 80,
    periodEndsOn: '1 ottobre 2026',
    topUp: { url: 'https://app.example/fatturazione#ricarica', price: '€15', messages: 1000 },
    upgrade: { plan: 'E-commerce', price: '€79', url: 'https://app.example/fatturazione#piano' },
  },
  'quota-exhausted': {
    tenantName: 'Cantina <script>alert(1)</script>',
    periodEndsOn: '1 ottobre 2026',
    topUp: { url: 'https://app.example/fatturazione#ricarica', price: '€15', messages: 1000 },
    upgrade: null,
  },
  'trial-expiry': {
    tenantName: 'Cantina <script>alert(1)</script>',
    daysLeft: 3,
    upgradeUrl: 'https://app.example/billing',
  },
  'domain-claim-notice': {
    tenantName: 'Cantina <script>alert(1)</script>',
    domain: 'cantina.example',
    transferOn: '02/10/2026 09:00 UTC',
    manageUrl: 'https://app.example/domains',
  },
  'domain-claim-lost': {
    tenantName: 'Cantina <script>alert(1)</script>',
    domain: 'cantina.example',
    manageUrl: 'https://app.example/domains',
  },
  'domain-claim-won': {
    tenantName: 'Cantina <script>alert(1)</script>',
    domain: 'cantina.example',
    manageUrl: 'https://app.example/domains',
  },
  'domain-claim-withdrawn': {
    tenantName: 'Cantina <script>alert(1)</script>',
    domain: 'cantina.example',
    manageUrl: 'https://app.example/domains',
  },
  'payment-failed': {
    tenantName: 'Cantina <script>alert(1)</script>',
    billingUrl: 'https://app.example/fatturazione',
  },
  'downgrade-deferred': {
    tenantName: 'Cantina <script>alert(1)</script>',
    keptPlan: 'E-commerce',
    wantedPlan: 'Cantina',
    reason: 'Cantina allows 300 wines and 1 domain. To move to Cantina, archive 112 wines first.',
    billingUrl: 'https://app.example/fatturazione',
  },
};

const renderAll = (locale: Locale) =>
  TEMPLATE_NAMES.map((name) => ({
    name,
    // The map above is keyed by template name, so this correspondence is the
    // one `renderTemplate`'s own signature enforces at every real call site.
    rendered: renderTemplate(name, PROPS[name] as never, locale),
  }));

describe('templates', () => {
  it.each(LOCALES)('renders every template in %s with both body parts', (locale) => {
    // Guards the guard: an empty list would make every assertion below pass
    // while checking nothing.
    expect(TEMPLATE_NAMES.length).toBe(11);

    for (const { name, rendered } of renderAll(locale)) {
      expect(rendered.subject.trim(), `${name}: subject`).not.toBe('');

      /*
       * Both parts, for every template. HTML-only mail scores worse with spam
       * filters, and these are the messages that have to arrive — so the
       * plaintext part is asserted structurally rather than trusted to a
       * reviewer noticing its absence.
       */
      expect(rendered.html, `${name}: html`).toContain('<body');
      expect(rendered.text.trim(), `${name}: text`).not.toBe('');
    }
  });

  it('declares the locale on the document, for screen readers', () => {
    expect(renderTemplate('password-reset', PROPS['password-reset'], 'it').html).toContain(
      '<html lang="it">',
    );
    expect(renderTemplate('password-reset', PROPS['password-reset'], 'en').html).toContain(
      '<html lang="en">',
    );
  });

  it('says something different in each locale', () => {
    /*
     * Catches the failure mode a "both locales render" test cannot: a template
     * whose Italian entry was copied from the English one and never translated.
     * It renders fine, passes every other assertion here, and reaches an
     * Italian customer in English.
     */
    for (const name of TEMPLATE_NAMES) {
      const it_ = renderTemplate(name, PROPS[name] as never, 'it');
      const en = renderTemplate(name, PROPS[name] as never, 'en');
      expect(it_.text, `${name}: locales are identical`).not.toBe(en.text);
    }
  });

  it('escapes a tenant name into the HTML part', () => {
    const rendered = renderTemplate('invite', PROPS.invite, 'it');

    // A seller controls their own winery name, and it is interpolated into mail
    // sent to someone else. This is the injection that matters here.
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');

    // The plaintext part is not escaped, and must not be: there is no markup to
    // escape into, and `&lt;` in a text body is just wrong on screen.
    expect(rendered.text).toContain('<script>');
  });

  it('escapes ampersands once', () => {
    // The classic ordering bug: `<` replaced before `&` yields `&amp;lt;`.
    expect(escapeHtml('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });

  it('refuses a link scheme that is not http or https', () => {
    /*
     * The URL is composed from configuration and from a token, so "it is always
     * ours" is an assumption rather than a guarantee. Escaping does nothing
     * about `javascript:` — the quotes in the href are already fine — so the
     * scheme has to be checked, and it is checked in the renderer where no
     * template can skip it.
     */
    expect(() =>
      renderTemplate('invite', { ...PROPS.invite, acceptUrl: 'javascript:alert(1)' }, 'it'),
    ).toThrow(UnsafeEmailUrlError);
  });

  it('refuses a relative URL', () => {
    // The realistic mistake, not the malicious one: a caller passing the path
    // it would use in the dashboard. A relative href in an email resolves
    // against nothing and the link is simply dead, which is worse than an error
    // because the send succeeds.
    expect(() =>
      renderTemplate('invite', { ...PROPS.invite, acceptUrl: '/invite/abc' }, 'it'),
    ).toThrow(UnsafeEmailUrlError);
  });

  it('puts the whole URL in the plaintext part', () => {
    // "Click here" is useless in a text body, and the reader on a text-only
    // client is exactly the one who cannot click anything.
    expect(renderTemplate('password-reset', PROPS['password-reset'], 'it').text).toContain(
      'https://app.example/reset/xyz',
    );
  });
});

describe('the quota notices (P5-12)', () => {
  it('offer the top-up and the next plan, each as a link to the Fatturazione screen', () => {
    const rendered = renderTemplate('quota-warning', PROPS['quota-warning'], 'it');

    expect(rendered.text).toContain('Acquista Ricarica +1.000 messaggi (€15)');
    expect(rendered.text).toContain('https://app.example/fatturazione#ricarica');
    expect(rendered.text).toContain('Passa al piano E-commerce (€79/mese)');
    expect(rendered.text).toContain('https://app.example/fatturazione#piano');
  });

  it('offer only the top-up on the top plan, where there is nothing to move up to', () => {
    const rendered = renderTemplate('quota-exhausted', PROPS['quota-exhausted'], 'it');

    expect(rendered.text).toContain('Ricarica immediata (€15)');
    expect(rendered.text).not.toContain('Passa al piano');
  });

  it('offer a plan alone to a winery with none, which a top-up cannot be added to', () => {
    const rendered = renderTemplate(
      'quota-exhausted',
      {
        ...PROPS['quota-exhausted'],
        topUp: null,
        upgrade: { plan: 'Cantina', price: '€29', url: 'https://app.example/fatturazione#piano' },
      },
      'it',
    );

    expect(rendered.text).not.toContain('Ricarica');
    expect(rendered.text).toContain('Passa al piano Cantina (€29/mese)');
    expect(rendered.text).toContain('Scegliere un piano lo riattiva subito.');
  });

  it('say the widget is paused when the month is spent, and until when', () => {
    expect(renderTemplate('quota-exhausted', PROPS['quota-exhausted'], 'en').text).toContain(
      'no longer answering visitors until 1 ottobre 2026',
    );
  });
});
