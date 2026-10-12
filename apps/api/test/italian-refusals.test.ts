import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as core from '@catalogorosso/core';
import {
  capMessage,
  CLAIM_ALREADY_YOURS,
  CLAIM_NOTICED,
  CLAIM_RACED,
  CLAIM_TRANSFERRED,
  CLAIM_WITHDRAWN,
  DEV_MODE_LOCAL_ONLY,
  dnsRefusalMessage,
  DomainError,
  downgradeRefusal,
  LAST_DOMAIN_WARNING,
  ORIGIN_UNAVAILABLE,
  PLAN_IDS,
  RANGE_EXPECTED,
  refusalMessage,
  SHOP_EXPECTED,
  SHOPIFY_UNVERIFIABLE,
  STAGING_CAP_MESSAGE,
  VARIANT_ID_EXPECTED,
  wellKnownRefusalMessage,
  type Blocker,
} from '@catalogorosso/core';
import type { NormalizeFailure, PlanTier } from '@catalogorosso/security';
import type { DnsFailure, WellKnownFailure } from '@catalogorosso/security/net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { registeredRoutes } from '../src/middleware/capability.js';
import { WIDGET_REFUSED } from '../src/middleware/cors.js';
import { logger } from '../src/middleware/logger.js';
import { DASHBOARD_PREFIX } from '../src/routes.js';
import { TURNSTILE_REFUSED } from '../src/turnstile.js';
import { WIDGET_UNAVAILABLE } from '../src/widget-config.js';
import { WIDGET_TOKEN_REFUSED } from '../src/widget-token.js';
import { fakeAuth, memberships, oneMembership, signedIn } from './support/auth.js';
import { englishIn, languageOf, refusalsIn, type Refusal } from './support/refusals.js';

/**
 * Everything a seller reads is Italian (Open Decision 6, P6-12).
 *
 * The dashboard prints a refusal's message as it arrives (P0-55), so the
 * sentence is written in Italian where it is thrown. That holds for exactly as
 * long as nobody adds an English one — and the next refusal will be written by
 * somebody reading the English ones the widget's routes still have, two files
 * away. So the words are read out of the source, every one of them, and the
 * routes are walked for the ones no file writes down.
 *
 * What a developer reads stays English: the widget's routes (the widget maps
 * codes to its own copy and never shows a message), the server-to-server
 * session route a seller's developers call (P4-10), and the webhooks.
 */

const REPO = join(import.meta.dirname, '../../..');

/** Why each of these is read by a developer, and so is English. Everything else is a seller's. */
const READ_BY_A_DEVELOPER: ReadonlyMap<string, string> = new Map([
  ['apps/api/src/surfaces/widget.ts', 'the widget shows its own copy for a code, never a message'],
  ['apps/api/src/middleware/cors.ts', 'a refused origin: read in a browser console'],
  ['apps/api/src/middleware/rate-limit.ts', 'the widget and server-session limits'],
  ['apps/api/src/middleware/widget-auth.ts', 'the widget’s token'],
  ['apps/api/src/widget-session.ts', 'the widget’s session'],
  ['apps/api/src/server-session.ts', 'called from a seller’s own backend (P4-10)'],
  ['apps/api/src/surfaces/webhooks.ts', 'answered to Resend, Stripe and Shopify'],
  ['apps/api/src/middleware/origin-secret.ts', 'whoever reached the origin around the CDN'],
  ['apps/api/src/surfaces/dev.ts', 'the development surface, never mounted in production'],
  ['apps/api/src/dev-billing.ts', 'the development surface'],
  [
    'packages/core/src/rag/embed-query.ts',
    'behind both surfaces’ own check for an empty question, so said by neither',
  ],
]);

/**
 * A message handed on rather than written or named, and why that is safe.
 *
 * Only ever the development surface relaying a synthetic event's refusal. On a
 * seller's route this would be P0-55's own mistake — somebody else's `.message`
 * returned to a caller — and it is not excused here.
 */
const RELAYED: ReadonlyMap<string, string> = new Map([
  ['apps/api/src/dev-billing.ts error.message', 'a `SyntheticEventRefused`, on the dev surface'],
]);

const filesUnder = (directory: string): string[] =>
  readdirSync(join(REPO, directory), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(REPO.length + 1)
        .replaceAll('\\', '/'),
    )
    .sort();

const isRefusal = (className: string): boolean => {
  const exported = (core as Record<string, unknown>)[className];

  return typeof exported === 'function' && exported.prototype instanceof DomainError;
};

interface Found extends Refusal {
  readonly file: string;
}

const FOUND: readonly Found[] = [
  ...filesUnder('apps/api/src'),
  ...filesUnder('packages/core/src'),
].flatMap((file) =>
  refusalsIn(readFileSync(join(REPO, file), 'utf8'), isRefusal).map((refusal) => ({
    ...refusal,
    file,
  })),
);

const forDevelopers = (found: Found): boolean => READ_BY_A_DEVELOPER.has(found.file);
const SELLERS = FOUND.filter((found) => !forDevelopers(found));
const DEVELOPERS = FOUND.filter(forDevelopers);

const where = (found: Found): string => `${found.file}:${String(found.line)}`;

/*
 * Exhaustive by type: a reason added to any of these unions fails to compile
 * here until it is listed, and so cannot reach a seller unread.
 */
const NORMALIZE_FAILURES: Record<NormalizeFailure, true> = {
  invalid_url: true,
  not_https: true,
  ip_literal: true,
  public_suffix: true,
  single_label: true,
  has_path: true,
  localhost: true,
};
const DNS_FAILURES: Record<DnsFailure, true> = {
  no_record: true,
  mismatch: true,
  resolver_error: true,
};
const WELL_KNOWN_FAILURES: Record<WellKnownFailure, true> = {
  not_found: true,
  mismatch: true,
  unreachable: true,
};
const TIERS: Record<PlanTier, true> = { CANTINA: true, ECOMMERCE: true, none: true };

const keysOf = <K extends string>(record: Record<K, true>): K[] => Object.keys(record) as K[];

const BLOCKERS: readonly (readonly Blocker[])[] = [
  [{ what: 'wines', have: 301, allowed: 300 }],
  [{ what: 'wines', have: 412, allowed: 300 }],
  [{ what: 'domains', have: 2, allowed: 1 }],
  [{ what: 'domains', have: 4, allowed: 1 }],
  [
    { what: 'wines', have: 412, allowed: 300 },
    { what: 'domains', have: 3, allowed: 1 },
  ],
];

/**
 * The words behind a name a file uses and does not define: a constant from
 * another module, or a function, called with everything it can be called with.
 *
 * **A name that is not here fails the suite**, which is what makes the scan
 * complete rather than best-effort. Import the words and add the line.
 */
const NAMED: ReadonlyMap<string, readonly string[]> = new Map([
  ['capMessage', keysOf(TIERS).flatMap((tier) => [1, 2, 5].map((cap) => capMessage(tier, cap)))],
  ['refusalMessage', keysOf(NORMALIZE_FAILURES).map(refusalMessage)],
  [
    'downgradeRefusal',
    PLAN_IDS.flatMap((plan) => BLOCKERS.map((blockers) => downgradeRefusal(plan, blockers))),
  ],
  ['ORIGIN_UNAVAILABLE', [ORIGIN_UNAVAILABLE]],
  ['STAGING_CAP_MESSAGE', [STAGING_CAP_MESSAGE]],
  ['LAST_DOMAIN_WARNING', [LAST_DOMAIN_WARNING]],
  ['SHOPIFY_UNVERIFIABLE', [SHOPIFY_UNVERIFIABLE]],
  ['CLAIM_ALREADY_YOURS', [CLAIM_ALREADY_YOURS]],
  ['CLAIM_RACED', [CLAIM_RACED]],
  ['DEV_MODE_LOCAL_ONLY', [DEV_MODE_LOCAL_ONLY]],
  ['RANGE_EXPECTED', [RANGE_EXPECTED]],
  ['SHOP_EXPECTED', [SHOP_EXPECTED]],
  ['VARIANT_ID_EXPECTED', [VARIANT_ID_EXPECTED]],
  ['TURNSTILE_REFUSED', [TURNSTILE_REFUSED]],
  ['WIDGET_REFUSED', [WIDGET_REFUSED]],
  ['WIDGET_TOKEN_REFUSED', [WIDGET_TOKEN_REFUSED]],
  ['WIDGET_UNAVAILABLE', [WIDGET_UNAVAILABLE]],
]);

/** Every sentence a set of refusals can say, each with where it is said. */
const sentencesOf = (found: readonly Found[]): { said: [string, string][]; unread: string[] } => {
  const said: [string, string][] = [];
  const unread: string[] = [];

  for (const refusal of found) {
    if (refusal.written !== '') said.push([where(refusal), refusal.written]);

    for (const name of refusal.named) {
      const words = NAMED.get(name);

      if (words !== undefined) {
        said.push(
          ...words.map((sentence): [string, string] => [`${where(refusal)} ${name}`, sentence]),
        );
      } else if (!RELAYED.has(`${refusal.file} ${name}`)) {
        unread.push(`${where(refusal)} names ${name}`);
      }
    }
  }

  return { said, unread };
};

describe('reading the refusals out of the source', () => {
  it('finds them: the scan is not passing because it sees nothing', () => {
    const written = SELLERS.map((found) => found.written);

    /* One from a route, one from a port, one from core, one from a middleware's template. */
    expect(written).toContain('Questo invito non esiste.');
    expect(written).toContain('Questa cantina ha già questo piano.');
    expect(written).toContain('Questo membro non esiste.');
    expect(written).toContain(
      'Il tuo ruolo non può fare questa operazione ( ). Chiedi a un titolare.',
    );
    expect(SELLERS.length).toBeGreaterThan(100);
    expect(DEVELOPERS.length).toBeGreaterThan(20);
  });

  it('follows a constant to where the file defines it', () => {
    const source = `
      const WHY = 'Non si può, ' + \`perché \${String(n)} \${n === 1 ? 'vino' : 'vini'}.\`;
      throw new ConflictError(WHY);
      throw new NotFoundError();
      throw new ConflictError(capMessage(plan, 'not a sentence'));
      throw new ConflictError(outcome.message, { cause: error });
      throw new WiringError('No port was supplied, so this is a bug.');
    `;

    expect(
      refusalsIn(source, isRefusal).map(({ error, bare, written, named }) => ({
        error,
        bare,
        written,
        named,
      })),
    ).toEqual([
      { error: 'ConflictError', bare: false, written: 'Non si può, perché vino vini .', named: [] },
      { error: 'NotFoundError', bare: true, written: '', named: [] },
      { error: 'ConflictError', bare: false, written: '', named: ['capMessage'] },
      { error: 'ConflictError', bare: false, written: '', named: ['outcome.message'] },
    ]);
  });

  it.each([
    ['Questo vino non esiste.', 'italian'],
    ['Indica «from» e «to» come giorni, con «from» non successivo a «to».', 'italian'],
    ['Non sembra un dominio. Scrivilo come cantina.it oppure www.cantina.it.', 'italian'],
    ['Invia un corpo JSON che indica il piano: {"plan": "CANTINA"}.', 'italian'],
    ['No such product.', 'neither'],
    ['Invalid code', 'neither'],
    ['Not found', 'english'],
    ['This winery already has keys.', 'english'],
    /* Half-translated is not translated. */
    ['Questo dominio is already in uso.', 'english'],
  ] as const)('tells the language of “%s”: %s', (sentence, language) => {
    expect(languageOf(sentence)).toBe(language);
  });
});

describe('what a seller is told (P6-12)', () => {
  const { said, unread } = sentencesOf(SELLERS);

  it('is written or named somewhere the scan can read it', () => {
    expect(unread).toEqual([]);
  });

  it('is Italian, every sentence of it', () => {
    const wrong = said
      .filter(([, sentence]) => languageOf(sentence) !== 'italian')
      .map(([at, sentence]) => `${at}: “${sentence}” (${englishIn(sentence).join(', ')})`);

    expect(wrong).toEqual([]);
  });

  it('is Italian when a refusal is given no words of its own', () => {
    /*
     * `new NotFoundError()` says the class's default, and the classes that
     * are thrown bare are thrown on the dashboard's routes.
     */
    const defaults = Object.entries(core as Record<string, unknown>).flatMap(
      ([name, exported]): [string, string][] =>
        typeof exported === 'function' && exported.prototype instanceof DomainError
          ? [[name, new (exported as new () => DomainError)().message]]
          : [],
    );

    expect(defaults.length).toBeGreaterThanOrEqual(9);
    expect(defaults.filter(([, message]) => languageOf(message) !== 'italian')).toEqual([]);
  });

  it('is Italian in an answer that is not a refusal: why a check has not passed yet', () => {
    /* A 200 with `verified: false` carries a reason, and a claim its outcome. */
    const sentences = [
      ...keysOf(DNS_FAILURES).map(dnsRefusalMessage),
      ...keysOf(WELL_KNOWN_FAILURES).map(wellKnownRefusalMessage),
      CLAIM_TRANSFERRED,
      CLAIM_NOTICED,
      CLAIM_WITHDRAWN,
    ];

    expect(sentences.filter((sentence) => languageOf(sentence) !== 'italian')).toEqual([]);
  });

  it('has no English sentence under `reason` or `message` in a file a seller’s routes use', () => {
    const sellerFiles = [...filesUnder('apps/api/src'), ...filesUnder('packages/core/src')].filter(
      (file) => !READ_BY_A_DEVELOPER.has(file) && file.startsWith('apps/api/src/'),
    );
    const wrong: string[] = [];

    for (const file of sellerFiles) {
      const source = readFileSync(join(REPO, file), 'utf8');

      /* A literal straight after the key: a code such as 'expired' reads as neither. */
      for (const match of source.matchAll(/\b(?:reason|message):\s*(?=['`])/gu)) {
        const [first] = refusalsIn(
          `new ConflictError(${source.slice(match.index + match[0].length)}`,
          isRefusal,
        );

        if (first !== undefined && languageOf(first.written) === 'english') {
          const line = source.slice(0, match.index).split('\n').length;

          wrong.push(`${file}:${String(line)}: “${first.written}”`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });
});

describe('what a developer is told stays as it was', () => {
  const { said, unread } = sentencesOf(DEVELOPERS);

  it.each([...READ_BY_A_DEVELOPER.keys()])('%s still refuses something', (file) => {
    /* A file that moved or stopped refusing is a line here that excuses nothing. */
    expect(DEVELOPERS.some((found) => found.file === file)).toBe(true);
  });

  it('is written or named somewhere the scan can read it', () => {
    expect(unread).toEqual([]);
  });

  it('is not Italian, any sentence of it', () => {
    /*
     * "Not Italian" rather than "English": `No such winery.` has no word from
     * either list, and a short English sentence is still what a developer
     * should read. What must not happen is a seller's sentence turning up here.
     */
    expect(said.length).toBeGreaterThan(20);
    expect(said.filter(([, sentence]) => languageOf(sentence) === 'italian')).toEqual([]);
  });

  it('never leans on a default, which is a seller’s', () => {
    /* The classes' own messages are Italian now; a bare one here would put Italian in a widget's console. */
    expect(DEVELOPERS.filter((found) => found.bare).map(where)).toEqual([]);
  });
});

describe('walking the dashboard’s routes', () => {
  beforeEach(() => {
    /* An unwired port is a 500 and a logged error on purpose; forty of them are noise. */
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const OWNER = 'user_owner';
  const TENANT = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const ORIGIN = 'https://app.catalogorosso.test';

  const NOTHING = undefined;
  const JSON_OBJECT = JSON.stringify({ nonsense: true });

  /** Who is asking, and with what: each is a way to be refused before or inside a route. */
  const CALLERS: readonly (readonly [
    string,
    Parameters<typeof createApp>[0],
    Record<string, string>,
    string | undefined,
  ])[] = [
    ['nobody', { auth: fakeAuth(), readMemberships: oneMembership() }, {}, NOTHING],
    [
      'somebody with no winery',
      { auth: signedIn(OWNER), readMemberships: memberships([]) },
      {},
      NOTHING,
    ],
    [
      'somebody with two wineries who names neither',
      {
        auth: signedIn(OWNER),
        readMemberships: memberships([
          { tenantId: TENANT, role: 'OWNER' },
          { tenantId: OTHER, role: 'OWNER' },
        ]),
      },
      {},
      NOTHING,
    ],
    [
      'somebody naming a winery that is not theirs',
      { auth: signedIn(OWNER), readMemberships: oneMembership(TENANT) },
      { 'x-tenant-id': OTHER },
      NOTHING,
    ],
    [
      'an editor',
      { auth: signedIn(OWNER), readMemberships: oneMembership(TENANT, 'EDITOR') },
      {},
      JSON_OBJECT,
    ],
    [
      'an owner with no second factor',
      { auth: signedIn(OWNER, { mfa: false }), readMemberships: oneMembership(TENANT) },
      {},
      JSON_OBJECT,
    ],
    [
      'an owner whose verification has gone stale',
      { auth: signedIn(OWNER, { fresh: false }), readMemberships: oneMembership(TENANT) },
      {},
      JSON_OBJECT,
    ],
    [
      'an owner sending a body that is not what the route takes',
      { auth: signedIn(OWNER), readMemberships: oneMembership(TENANT) },
      {},
      JSON_OBJECT,
    ],
    [
      'an owner sending a body that is not JSON',
      { auth: signedIn(OWNER), readMemberships: oneMembership(TENANT) },
      {},
      '{',
    ],
    [
      'an owner sending nothing',
      { auth: signedIn(OWNER), readMemberships: oneMembership(TENANT) },
      {},
      NOTHING,
    ],
    [
      'a page on another site',
      {
        auth: signedIn(OWNER),
        readMemberships: oneMembership(TENANT),
        dashboardOrigin: ORIGIN,
      },
      { origin: 'https://evil.example' },
      JSON_OBJECT,
    ],
  ];

  interface Heard {
    readonly at: string;
    readonly code: string;
    readonly message: string;
  }

  const walk = async (
    options: Parameters<typeof createApp>[0],
    headers: Record<string, string>,
    body: string | undefined,
    mine: (path: string) => boolean,
  ): Promise<Heard[]> => {
    const app = createApp(options);
    const heard: Heard[] = [];

    /* The unknown route too: it is answered by the handler, not by a route. */
    const routes = [
      ...registeredRoutes(app)
        .filter((route) => route.capability === undefined && route.method !== 'ALL')
        .map((route) => ({ method: route.method, path: route.path })),
      { method: 'GET', path: `${DASHBOARD_PREFIX}/no-such-route` },
      { method: 'GET', path: '/v1/widget/no-such-route' },
    ].filter((route) => mine(route.path));

    for (const { method, path } of new Map(
      routes.map((route) => [`${route.method} ${route.path}`, route]),
    ).values()) {
      const safe = method === 'GET' || method === 'HEAD';
      const response = await app.request(path.replaceAll(/:[A-Za-z]+/gu, TENANT), {
        method,
        headers: {
          ...headers,
          ...(safe || body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(safe || body === undefined ? {} : { body }),
      });

      if (response.ok) continue;

      const answer = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };

      heard.push({
        at: `${method} ${path} → ${String(response.status)}`,
        code: answer.error?.code ?? 'no code',
        message: answer.error?.message ?? '',
      });
    }

    return heard;
  };

  const isDashboard = (path: string): boolean => path.startsWith(`${DASHBOARD_PREFIX}/`);

  it.each(CALLERS)(
    'refuses %s in Italian, on every route',
    async (_who, options, headers, body) => {
      const heard = await walk(options, headers, body, isDashboard);

      /* Walked off the router, so a route added tomorrow is walked tomorrow. */
      expect(heard.length).toBeGreaterThan(0);
      expect(
        heard
          .filter(({ message }) => languageOf(message) !== 'italian')
          .map(({ at, message }) => `${at}: “${message}”`),
      ).toEqual([]);
    },
  );

  it('meets every kind of refusal on the way, so the walk is not a walk past them', async () => {
    const codes = new Set<string>();

    for (const [, options, headers, body] of CALLERS) {
      for (const { code } of await walk(options, headers, body, isDashboard)) codes.add(code);
    }

    expect([...codes].sort()).toEqual(
      [
        'forbidden',
        'internal',
        'invalid',
        'mfa_required',
        'not_found',
        'step_up_required',
        'unauthenticated',
      ].sort(),
    );
  });

  it('leaves every other surface’s refusals in English', async () => {
    const heard: Heard[] = [];

    for (const [, options, headers, body] of CALLERS) {
      heard.push(...(await walk(options, headers, body, (path) => !isDashboard(path))));
    }

    expect(heard.length).toBeGreaterThan(0);
    expect(heard.filter(({ message }) => languageOf(message) === 'italian')).toEqual([]);
  });

  it.each([
    [`${DASHBOARD_PREFIX}/no-such-route`, 'Non trovato.'],
    ['/v1/widget/no-such-route', 'Not found'],
    /* A neighbour by name, not a part of it. */
    [`${DASHBOARD_PREFIX}x/no-such-route`, 'Not found'],
    ['/no-such-route', 'Not found'],
  ])('answers a route that is not there, at %s, with “%s”', async (path, message) => {
    const response = await createApp({
      auth: signedIn(OWNER),
      readMemberships: oneMembership(TENANT),
    }).request(path);

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(message);
  });
});
