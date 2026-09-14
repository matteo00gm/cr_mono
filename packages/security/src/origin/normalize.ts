import { parse } from 'tldts';

/**
 * Origin normalisation (P2-05, §3.3).
 *
 * **Every CORS decision depends on this one function.** Arbitrary input — what
 * a seller types into the domains screen, or what a browser sends in `Origin` —
 * becomes one canonical serialised origin, or a typed refusal. P2-08 then
 * compares that string for exact equality against the verified set, so a bug
 * here is the difference between an allowlist and an open door: the classic
 * bypasses (`evil-winery.com`, `winery.com.attacker.io`) all live at this
 * boundary.
 *
 * Pure and synchronous, with no I/O. The Public Suffix List is the one bundled
 * with `tldts`, so an answer never depends on a network fetch or on the day.
 *
 * **There is no code path that accepts a wildcard.** `*` fails the label check
 * like any other character a hostname cannot contain (§3.3: exact origins only).
 */

export type NormalizeFailure =
  | 'invalid_url'
  | 'not_https'
  | 'ip_literal'
  | 'public_suffix'
  | 'single_label'
  | 'has_path'
  | 'localhost';

export type NormalizeResult =
  | { readonly ok: true; readonly origin: string; readonly registrableDomain: string }
  | { readonly ok: false; readonly reason: NormalizeFailure };

export interface NormalizeOptions {
  /**
   * `development` admits `http:` and `localhost`, which a local run needs and a
   * deployed stage must never accept. **Production is the default**, so a
   * caller that forgets to say gets the strict answer rather than the open one.
   */
  readonly environment?: 'production' | 'development' | undefined;
}

/**
 * One DNS label in the form the `tenant_domains` CHECK constraint accepts:
 * lowercase letters, digits and inner hyphens.
 *
 * Checked here even though `URL` accepts more — `win_ery.com`, `-winery.com` —
 * because this function is the authority on what an origin is. A value it
 * accepted and the database then refused would surface as a 500 at the moment
 * a seller adds a domain.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** DNS's own ceiling on a whole name. */
const MAX_HOSTNAME = 253;

/**
 * An IPv4 literal, after `URL` has normalised it.
 *
 * The parser rewrites every legacy form — `0x7f.1`, `2130706433`, `127.1` — to
 * a dotted quad, so matching the dotted quad here catches all of them.
 */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const refuse = (reason: NormalizeFailure): NormalizeResult => ({ ok: false, reason });

/** `URL` throws on input it cannot parse; a refusal is the answer, not an exception. */
const parseUrl = (input: string): URL | undefined => {
  try {
    return new URL(input);
  } catch {
    return undefined;
  }
};

/** Scheme, host and a non-default port — no trailing slash, as a browser sends `Origin`. */
const serialise = (protocol: string, host: string, port: string): string =>
  `${protocol}//${host}${port === '' ? '' : `:${port}`}`;

export const normalizeOrigin = (
  input: string,
  { environment = 'production' }: NormalizeOptions = {},
): NormalizeResult => {
  const development = environment === 'development';
  const trimmed = input.trim();

  if (trimmed === '') return refuse('invalid_url');

  /*
   * A scheme is recognised only by `://`. `winery.com:8443` has a colon too, and
   * reading it as a scheme called `winery.com` would refuse a legitimate origin
   * with a port — while `javascript:alert(1)`, given `https://` in front, stops
   * parsing as a URL at all.
   */
  const url = parseUrl(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  if (url === undefined) return refuse('invalid_url');

  const allowedProtocol = url.protocol === 'https:' || (development && url.protocol === 'http:');
  if (!allowedProtocol) return refuse('not_https');

  /*
   * `https://winery.com@evil.io` is a request for `evil.io` with a username of
   * `winery.com`. There is no origin that carries credentials, so any is a
   * refusal rather than something to strip.
   */
  if (url.username !== '' || url.password !== '') return refuse('invalid_url');

  /*
   * A domain with a path, query or fragment is a misunderstanding rather than
   * something to strip silently (§3.3). `URL` reports an empty query for a bare
   * `?`, so the raw input is checked for the delimiters as well.
   */
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || /[?#]/.test(trimmed)) {
    return refuse('has_path');
  }

  /*
   * One trailing dot is the fully qualified form of the same name, so
   * `winery.com.` and `winery.com` normalise to one origin. A second is an empty
   * label, and the label check refuses it.
   */
  const host = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname;

  if (host.startsWith('[') || IPV4.test(host)) return refuse('ip_literal');

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return development
      ? { ok: true, origin: serialise(url.protocol, host, url.port), registrableDomain: host }
      : refuse('localhost');
  }

  const labels = host.split('.');
  if (host.length > MAX_HOSTNAME || !labels.every((label) => LABEL.test(label))) {
    return refuse('invalid_url');
  }

  /*
   * `allowPrivateDomains` so that `myshopify.com` and `github.io` count as
   * public suffixes. Without it `shop.myshopify.com` would reduce to
   * `myshopify.com`, and one verification would stand for every shop on the
   * platform.
   */
  const { domain, isIcann } = parse(host, { allowPrivateDomains: true });

  /*
   * A single label is either a real public suffix (`com`) or not a public name
   * at all (`winery`). The Public Suffix List's default rule treats any unknown
   * top-level label as a suffix, so only an entry on the list itself earns the
   * `public_suffix` reason.
   */
  if (labels.length === 1) return refuse(isIcann === true ? 'public_suffix' : 'single_label');
  if (domain === null) return refuse('public_suffix');

  return { ok: true, origin: serialise(url.protocol, host, url.port), registrableDomain: domain };
};
