import { lookup as systemLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest, type RequestOptions } from 'node:https';

import { isPublicUnicast } from './addresses.js';

/**
 * Fetching a URL a seller chose, without fetching our own inside (P4-03a, §3.3).
 *
 * **The fetch is three lines; the constraints are the substance.** Domain
 * verification asks a server we control to make a request to a host an
 * attacker controls, which is the textbook SSRF shape — and the textbook
 * mitigation is wrong.
 *
 * **Resolve, check, then fetch is a TOCTOU bug.** DNS rebinding defeats it: the
 * attacker's nameserver answers the validation lookup with a public address and
 * the lookup `fetch` performs moments later with `169.254.169.254`. Every
 * address the check saw was fine; the address the socket connected to was not.
 * Pre-resolution validation is theatre against an attacker who controls the DNS
 * response, which — since they chose the hostname — they do by definition.
 *
 * **So the address that gets checked is the address that gets connected to**,
 * with no second lookup in between: the validation runs *inside* the
 * connection's own `lookup`, and pins the address it approved.
 *
 * Everything else is the other half of the same attack:
 *
 * - **No redirects at all.** A 302 to `http://169.254.169.254/` is how a host
 *   that passes every check reaches the metadata endpoint anyway.
 * - **`https` and port 443 only.** A URL naming another port is a port scan
 *   with our source address.
 * - **The body is capped and read incrementally**, so a gigabyte response
 *   cannot be streamed into a Lambda's memory.
 * - **A timeout**, because a host that accepts and never answers holds a
 *   connection for as long as we let it.
 * - **No request headers carrying anything tenant-supplied**, so this cannot be
 *   turned into a way to send data somewhere of the attacker's choosing.
 */

/** Long enough for a slow origin, short enough that a hanging host is not free. */
export const GUARDED_TIMEOUT_MS = 5000;

/** A verification file is 64 hex characters. A kilobyte is already generous. */
export const MAX_BODY_BYTES = 1024;

/** Why a fetch was refused, as a code a caller can branch on. */
export type GuardedFailure =
  | 'blocked_address'
  | 'blocked_scheme'
  | 'blocked_port'
  | 'blocked_redirect'
  | 'dns_failure'
  | 'timeout'
  | 'too_large'
  | 'network';

export class GuardedFetchRefused extends Error {
  constructor(readonly reason: GuardedFailure) {
    super(`The request was refused: ${reason}.`);
    this.name = 'GuardedFetchRefused';
  }
}

/** The shape Node hands a custom `lookup`, narrowed to what this uses. */
export type LookupFn = (
  hostname: string,
  options: { readonly family?: number | undefined },
  callback: (error: Error | null, address: string, family: number) => void,
) => void;

/** Resolves every address for a host. Injected so a test can simulate rebinding. */
export type ResolveAll = (
  hostname: string,
  callback: (error: Error | null, addresses: readonly LookupAddress[]) => void,
) => void;

/**
 * The resolver production uses, adapted to the shape above.
 *
 * **`addresses` is `undefined` on failure**, whatever the types say — Node
 * calls back with one argument when `getaddrinfo` fails, and reading it as an
 * array throws inside a callback nothing is there to catch.
 */
const systemResolveAll: ResolveAll = (hostname, callback) => {
  systemLookup(hostname, { all: true }, (error, addresses: LookupAddress[] | undefined) => {
    callback(error, addresses ?? []);
  });
};

/**
 * A `lookup` that refuses to resolve to anywhere we should not go.
 *
 * **Every returned address must pass, not just the first.** A host can answer
 * with several A records, and an implementation that checks `addresses[0]` and
 * lets the stack connect to any of them has checked nothing — a mixed set is
 * not a partial risk, it is a deliberate one.
 *
 * **The approved address is pinned**, handed back as a literal, so the socket
 * connects to the address that was checked rather than asking again.
 */
export const guardedLookup =
  (resolveAll: ResolveAll = systemResolveAll): LookupFn =>
  (hostname, _options, callback) => {
    resolveAll(hostname, (error, addresses) => {
      const [first] = addresses;

      /* An answer with no records is a failed answer, which is why the empty
       * case and the error case share a reason rather than each getting one. */
      if (error !== null || first === undefined) {
        callback(new GuardedFetchRefused('dns_failure'), '', 0);

        return;
      }

      for (const candidate of addresses) {
        if (!isPublicUnicast(candidate.address)) {
          callback(new GuardedFetchRefused('blocked_address'), '', 0);

          return;
        }
      }

      callback(null, first.address, first.family);
    });
  };

export interface GuardedFetchOptions {
  /** Injected so a test can simulate a rebinding resolver without a nameserver. */
  readonly resolveAll?: ResolveAll | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  /** Injected so a test can drive the request without a network. */
  readonly request?: typeof httpsRequest | undefined;
}

export interface GuardedResponse {
  readonly status: number;
  /** At most `maxBytes`, decoded as UTF-8. */
  readonly body: string;
}

/**
 * Fetches a URL, refusing anything that could reach our own network.
 *
 * Throws `GuardedFetchRefused` with a reason. A caller turns that into whatever
 * a seller should be told, which is never the reason itself: "we could not
 * reach your site" is true and gives an attacker nothing.
 */
export const guardedFetch = async (
  url: string,
  {
    resolveAll,
    timeoutMs = GUARDED_TIMEOUT_MS,
    maxBytes = MAX_BODY_BYTES,
    request = httpsRequest,
  }: GuardedFetchOptions = {},
): Promise<GuardedResponse> => {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new GuardedFetchRefused('blocked_scheme');
  }

  if (parsed.protocol !== 'https:') throw new GuardedFetchRefused('blocked_scheme');

  /*
   * An explicit port is a port scan with our source address. `new URL()` drops
   * a scheme's default port, so `https://host:443/` arrives here with an empty
   * port and a second comparison against `'443'` would never run.
   */
  if (parsed.port !== '') throw new GuardedFetchRefused('blocked_port');

  const options: RequestOptions = {
    method: 'GET',
    host: parsed.hostname,
    port: 443,
    path: `${parsed.pathname}${parsed.search}`,
    /*
     * The validation runs inside the connection rather than before it, which is
     * the whole design. Nothing else in these options matters as much.
     */
    lookup: guardedLookup(resolveAll) as RequestOptions['lookup'],
    /* Nothing tenant-supplied, so this cannot carry data somewhere chosen. */
    headers: { accept: 'text/plain', 'user-agent': 'catalogorosso-verifier' },
    timeout: timeoutMs,
  };

  return new Promise<GuardedResponse>((resolve, reject) => {
    let settled = false;

    const fail = (reason: GuardedFailure): void => {
      if (settled) return;

      settled = true;
      reject(new GuardedFetchRefused(reason));
    };

    const outgoing = request(options, (response) => {
      const status = response.statusCode;

      /* A response with no status is one nothing can be decided from, and
       * deciding anyway is how a caller ends up treating it as a 200. */
      if (status === undefined) {
        response.destroy();
        fail('network');

        return;
      }

      /*
       * **Refused before a byte is read.** A 302 to an internal address is the
       * other half of the rebinding attack, and following it would undo every
       * check above — the redirect target gets its own connection, and this
       * code would not be the thing making it.
       */
      if (status >= 300 && status < 400) {
        response.destroy();
        fail('blocked_redirect');

        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;

      response.on('data', (chunk: Buffer) => {
        size += chunk.length;

        /*
         * Checked as it arrives, not after. A cap enforced on a buffered body
         * is a cap that has already spent the memory it exists to save.
         */
        if (size > maxBytes) {
          response.destroy();
          fail('too_large');

          return;
        }

        chunks.push(chunk);
      });

      response.on('end', () => {
        if (settled) return;

        settled = true;
        resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
      });

      response.on('error', () => {
        fail('network');
      });
    });

    outgoing.on('timeout', () => {
      outgoing.destroy();
      fail('timeout');
    });

    outgoing.on('error', (error: Error) => {
      /* The lookup's own refusal arrives here, and its reason is the useful one. */
      fail(error instanceof GuardedFetchRefused ? error.reason : 'network');
    });

    outgoing.end();
  });
};
