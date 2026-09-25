import { describe, expect, it, vi } from 'vitest';

import {
  publicResolveTxt,
  PUBLIC_RESOLVERS,
  VERIFY_LABEL,
  verifyDnsToken,
  type ResolveTxt,
} from '../src/net/verify-dns.js';

/**
 * Proving control of a domain through DNS (P4-02, §3.3).
 *
 * **The case this file exists for is the one nothing else would catch**: that
 * the resolver is a pinned public one rather than the host's. A verification
 * that trusts the VPC's resolver is a verification anybody who can reach the
 * DHCP options or a private zone can forge — and the forged answer is
 * indistinguishable from a real one, so no other test would ever go red.
 *
 * Everything else is what a seller's DNS actually looks like: several TXT
 * records at one name, a record they have not published yet, one they pasted
 * wrong, and a resolver that is having a bad day.
 */

/** Built at runtime, never written into the file (P0-56). */
const nonce = (): string =>
  Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

const answering =
  (records: string[][]): ResolveTxt =>
  () =>
    Promise.resolve(records);

const failing =
  (code: string): ResolveTxt =>
  () =>
    Promise.reject(Object.assign(new Error(code), { code }));

describe('the name it asks for', () => {
  it('is the nonce label under the registrable domain', async () => {
    const asked: string[] = [];
    const resolve: ResolveTxt = (hostname) => {
      asked.push(hostname);

      return Promise.resolve([]);
    };

    await verifyDnsToken('winery.com', nonce(), resolve);

    expect(asked).toEqual([`${VERIFY_LABEL}.winery.com`]);
  });

  it('uses the registrable domain, not the origin it came from', async () => {
    /*
     * The record goes at the apex a seller controls. Asking under
     * `shop.winery.com` would demand a second record for every subdomain, which
     * is the thing verifying the registrable domain exists to avoid (§3.3).
     */
    const asked: string[] = [];

    await verifyDnsToken('winery.com', nonce(), (hostname) => {
      asked.push(hostname);

      return Promise.resolve([]);
    });

    expect(asked[0]).not.toMatch(/shop|https/u);
    expect(asked[0]).toBe('_somm-verify.winery.com');
  });
});

describe('a domain that has published the record', () => {
  it('verifies', async () => {
    const token = nonce();

    await expect(verifyDnsToken('winery.com', token, answering([[token]]))).resolves.toEqual({
      ok: true,
    });
  });

  it('verifies when other vendors records sit beside ours', async () => {
    /*
     * **A real domain's TXT records are a set.** SPF, another vendor's
     * verification, an older nonce of ours. A check that read only the first
     * record would fail for every seller who already verifies with anybody
     * else — which is most of them.
     */
    const token = nonce();
    const records = [['v=spf1 include:_spf.google.com ~all'], ['some-other-vendor=abc'], [token]];

    await expect(verifyDnsToken('winery.com', token, answering(records))).resolves.toEqual({
      ok: true,
    });
  });

  it('verifies when ours is first', async () => {
    const token = nonce();

    await expect(
      verifyDnsToken('winery.com', token, answering([[token], ['v=spf1 ~all']])),
    ).resolves.toEqual({ ok: true });
  });

  it('joins a record the resolver handed back in chunks', async () => {
    /* Over 255 characters a TXT record arrives split, and the protocol says to
     * concatenate. Nothing else would reassemble it. */
    const token = nonce();
    const chunks = [token.slice(0, 20), token.slice(20)];

    await expect(verifyDnsToken('winery.com', token, answering([chunks]))).resolves.toEqual({
      ok: true,
    });
  });
});

describe('a domain that has not', () => {
  it('reports no record when the name does not exist', async () => {
    await expect(verifyDnsToken('winery.com', nonce(), failing('ENOTFOUND'))).resolves.toEqual({
      ok: false,
      reason: 'no_record',
    });
  });

  it('reports no record when the name exists with nothing at it', async () => {
    await expect(verifyDnsToken('winery.com', nonce(), failing('ENODATA'))).resolves.toEqual({
      ok: false,
      reason: 'no_record',
    });
  });

  it('reports no record for an empty answer', async () => {
    await expect(verifyDnsToken('winery.com', nonce(), answering([]))).resolves.toEqual({
      ok: false,
      reason: 'no_record',
    });
  });

  it('reports a mismatch when the records are somebody else entirely', async () => {
    /*
     * **Told apart from "no record" on purpose.** They are two different things
     * to put on the screen: one means "publish this", the other means "check
     * what you pasted", and a seller given the wrong one looks in the wrong
     * place.
     */
    await expect(
      verifyDnsToken('winery.com', nonce(), answering([['v=spf1 ~all']])),
    ).resolves.toEqual({ ok: false, reason: 'mismatch' });
  });

  it('reports a mismatch for a nonce that is nearly right', async () => {
    const token = nonce();
    const almost = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;

    await expect(verifyDnsToken('winery.com', token, answering([[almost]]))).resolves.toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('reports a mismatch for a nonce with something wrapped around it', async () => {
    /* A seller who pasted `"<nonce>"` or `somm-verify=<nonce>` has published
     * something that is not the record we asked for, and saying so is more
     * useful than silently accepting a prefix. */
    const token = nonce();

    await expect(
      verifyDnsToken('winery.com', token, answering([[`"${token}"`], [`somm=${token}`]])),
    ).resolves.toEqual({ ok: false, reason: 'mismatch' });
  });

  it('reports a mismatch rather than matching a prefix', async () => {
    const token = nonce();

    await expect(
      verifyDnsToken('winery.com', token, answering([[token.slice(0, 32)]])),
    ).resolves.toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('a lookup that fails at our end', () => {
  it('is retryable, not the seller fault', async () => {
    /*
     * A `SERVFAIL` or a timeout says nothing about whether the seller published
     * the record. Reporting it as "not found" would tell them to go and check
     * DNS they have already got right.
     */
    await expect(verifyDnsToken('winery.com', nonce(), failing('SERVFAIL'))).resolves.toEqual({
      ok: false,
      reason: 'resolver_error',
    });
  });

  it.each(['ETIMEOUT', 'ECONNREFUSED', 'EREFUSED', ''])(
    'reports %s as a resolver error',
    async (code) => {
      await expect(verifyDnsToken('winery.com', nonce(), failing(code))).resolves.toEqual({
        ok: false,
        reason: 'resolver_error',
      });
    },
  );

  it('reports a rejection that is not an Error at all as a resolver error', async () => {
    /* Nothing guarantees a rejection is an `Error`, and reading `.code` off a
     * string is how a resolver failure becomes a 500. */
    const rejecting: ResolveTxt = () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case
      Promise.reject('just a string');

    await expect(verifyDnsToken('winery.com', nonce(), rejecting)).resolves.toEqual({
      ok: false,
      reason: 'resolver_error',
    });
  });

  it.each([null, undefined, 42])('survives a rejection of %s', async (value) => {
    /*
     * **`null` is the one that bites.** Reading `.code` off it throws a
     * `TypeError` inside the catch, which turns a resolver hiccup into a 500 on
     * a screen a seller is already stuck on.
     */
    const rejecting: ResolveTxt = () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case
      Promise.reject(value);

    await expect(verifyDnsToken('winery.com', nonce(), rejecting)).resolves.toEqual({
      ok: false,
      reason: 'resolver_error',
    });
  });
});

describe('the resolver it uses when nobody supplies one', () => {
  it('asks public nameservers, never the host own', async () => {
    /*
     * **The assertion this file exists for.** Node's default resolver is
     * whatever the host was handed; in a VPC that is the VPC's, which answers
     * for internal names and can be reconfigured by anybody with that reach. A
     * verification that trusted it could be forged for any domain, and the
     * forged answer would look exactly like a real one — so no other test here
     * would ever go red.
     */
    const { Resolver } = await import('node:dns/promises');
    const setServers = vi.spyOn(Resolver.prototype, 'setServers');

    publicResolveTxt();

    expect(setServers).toHaveBeenCalledWith(['1.1.1.1', '8.8.8.8']);
    setServers.mockRestore();
  });

  it('names more than one, so a single resolver is not a single point of failure', () => {
    expect(PUBLIC_RESOLVERS.length).toBeGreaterThan(1);
  });

  it('names nothing private, which would defeat the point of pinning at all', async () => {
    const { isPublicUnicast } = await import('../src/net/addresses.js');

    for (const server of PUBLIC_RESOLVERS) {
      expect(isPublicUnicast(server)).toBe(true);
    }
  });

  it('is what a check uses when nobody hands it one', async () => {
    /*
     * **The default is what actually ships**, and an injected resolver in every
     * other case here proves nothing about it. `a..b` has an empty label, which
     * the resolver rejects itself as `EBADNAME` in about a millisecond and
     * without touching a network — so this exercises the real path offline.
     */
    await expect(verifyDnsToken('a..b', nonce())).resolves.toEqual({
      ok: false,
      reason: 'resolver_error',
    });
  });

  it('builds a fresh resolver each time', async () => {
    /*
     * A `Resolver` holds a channel. One at module scope would be shared across
     * every invocation on a warm container, with no way to reset it after a
     * failure — and comparing the *closures* would not notice, because those
     * differ either way. So this compares the receivers.
     */
    const { Resolver } = await import('node:dns/promises');
    const receivers: unknown[] = [];
    const setServers = vi.spyOn(Resolver.prototype, 'setServers').mockImplementation(function (
      this: unknown,
    ) {
      receivers.push(this);
    });

    publicResolveTxt();
    publicResolveTxt();
    setServers.mockRestore();

    expect(receivers).toHaveLength(2);
    expect(receivers[0]).not.toBe(receivers[1]);
  });
});
