import { EventEmitter } from 'node:events';
import type { LookupAddress } from 'node:dns';

import { describe, expect, it, vi } from 'vitest';

import {
  guardedFetch,
  guardedLookup,
  GuardedFetchRefused,
  GUARDED_TIMEOUT_MS,
  MAX_BODY_BYTES,
  type LookupFn,
  type ResolveAll,
} from '../src/net/guarded-fetch.js';

/**
 * Fetching a host a seller chose, without fetching our own inside (P4-03a).
 *
 * **The case this file exists for is the rebinding one**, and it is the only
 * one that distinguishes a real defence from the one everybody writes. Resolve,
 * check, then fetch passes every other test here and is defeated by a
 * nameserver that answers the second lookup differently — so there is a test
 * with a resolver that does exactly that, and it has to fail on the *second*
 * call rather than the first.
 *
 * Everything else is the other half of the same attack: a redirect, a port, a
 * scheme, a body that never ends, a host that never answers.
 */

const PUBLIC: LookupAddress[] = [{ address: '93.184.216.34', family: 4 }];
const PRIVATE: LookupAddress[] = [{ address: '169.254.169.254', family: 4 }];

const answering =
  (addresses: LookupAddress[]): ResolveAll =>
  (_hostname, callback) => {
    callback(null, addresses);
  };

/** A resolver that answers differently each time it is asked. */
const inSequence = (answers: LookupAddress[][]): ResolveAll => {
  let call = 0;

  return (_hostname, callback) => {
    const addresses = answers[call] ?? answers.at(-1) ?? [];

    call += 1;
    callback(null, addresses);
  };
};

const lookupResult = (resolve: ResolveAll): Promise<{ error: Error | null; address: string }> =>
  new Promise((done) => {
    guardedLookup(resolve)('winery.example', {}, (error, address) => {
      done({ error, address });
    });
  });

describe('the address a socket is given', () => {
  it('is one that was checked', async () => {
    const { error, address } = await lookupResult(answering(PUBLIC));

    expect(error).toBeNull();
    expect(address).toBe('93.184.216.34');
  });

  it('is refused when it is the metadata endpoint', async () => {
    const { error } = await lookupResult(answering(PRIVATE));

    expect(error).toMatchObject({ reason: 'blocked_address' });
  });

  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.0.0.1', 'the VPC'],
    ['::1', 'IPv6 loopback'],
    ['::ffff:169.254.169.254', 'the metadata endpoint in an IPv6 coat'],
  ])('is refused when it is %s (%s)', async (address) => {
    const { error } = await lookupResult(
      answering([{ address, family: address.includes(':') ? 6 : 4 }]),
    );

    expect(error).toMatchObject({ reason: 'blocked_address' });
  });

  it('is refused when any one of several records is private', async () => {
    /*
     * **A mixed set is not a partial risk, it is a deliberate one.** A host can
     * answer with several A records, and an implementation that checks the
     * first and lets the stack connect to any of them has checked nothing.
     */
    const { error } = await lookupResult(
      answering([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    );

    expect(error).toMatchObject({ reason: 'blocked_address' });
  });

  it('is refused when the private record comes first', async () => {
    const { error } = await lookupResult(
      answering([
        { address: '169.254.169.254', family: 4 },
        { address: '93.184.216.34', family: 4 },
      ]),
    );

    expect(error).toMatchObject({ reason: 'blocked_address' });
  });

  it('is refused when the resolver answers with nothing', async () => {
    const { error } = await lookupResult(answering([]));

    expect(error).toMatchObject({ reason: 'dns_failure' });
  });

  it('is refused when the resolver fails', async () => {
    const { error } = await lookupResult((_hostname, callback) => {
      callback(new Error('ENOTFOUND'), []);
    });

    expect(error).toMatchObject({ reason: 'dns_failure' });
  });

  it('is refused when the resolver fails and answers anyway', async () => {
    /*
     * **An error is an error, whatever came with it.** A resolver that reports
     * a failure and hands back records is one whose records mean nothing, and
     * the tidy version of this check — trusting the records because they are
     * there — reads as equivalent and is not.
     */
    const { error } = await lookupResult((_hostname, callback) => {
      callback(new Error('SERVFAIL'), PUBLIC);
    });

    expect(error).toMatchObject({ reason: 'dns_failure' });
  });

  it('asks the resolver exactly once, and pins what it approved', async () => {
    /*
     * **The whole design in one assertion.** The address that was checked is
     * the address handed to the socket — there is no second lookup for a
     * nameserver to answer differently.
     */
    const resolve = vi.fn<ResolveAll>((_hostname, callback) => {
      callback(null, PUBLIC);
    });

    await lookupResult(resolve);

    expect(resolve).toHaveBeenCalledOnce();
  });
});

describe('a nameserver that rebinds', () => {
  /*
   * **The attack the conventional mitigation loses to.** Resolve, check, then
   * fetch: the attacker answers the validation lookup with a public address and
   * the lookup `fetch` performs moments later with the metadata endpoint. Every
   * address the check saw was fine; the address the socket connected to was
   * not.
   */
  it('is refused on the answer the socket would have used', async () => {
    const resolve = inSequence([PUBLIC, PRIVATE]);

    /* The first lookup is the one a pre-flight check would have made. */
    expect((await lookupResult(resolve)).error).toBeNull();

    /* The second is the one the connection makes — and this is where the check
     * actually runs, so it refuses. */
    expect((await lookupResult(resolve)).error).toMatchObject({ reason: 'blocked_address' });
  });

  it('is refused on the first answer too, when that is the private one', async () => {
    const resolve = inSequence([PRIVATE, PUBLIC]);

    expect((await lookupResult(resolve)).error).toMatchObject({ reason: 'blocked_address' });
  });
});

describe('the resolver it uses when nobody supplies one', () => {
  /*
   * **The default is the thing that actually ships**, and an injected resolver
   * in every other test proves nothing about it. `localhost` is answered from
   * the hosts file rather than the network, so this stays an offline test while
   * exercising the real `dns.lookup` path.
   */
  it('is the system one, and it refuses localhost', async () => {
    const { error } = await new Promise<{ error: Error | null }>((done) => {
      guardedLookup()('localhost', {}, (lookupError) => {
        done({ error: lookupError });
      });
    });

    expect(error).toMatchObject({ reason: 'blocked_address' });
  });

  it('reports a name that does not resolve as a DNS failure', async () => {
    /*
     * **`a..b` has an empty label**, which `getaddrinfo` rejects itself — so
     * this fails in milliseconds and without a network, and it fails the way
     * production does: Node calls back with no addresses argument at all,
     * which is the thing that used to throw inside the callback.
     */
    const { error } = await new Promise<{ error: Error | null }>((done) => {
      guardedLookup()('a..b', {}, (lookupError) => {
        done({ error: lookupError });
      });
    });

    expect(error).toMatchObject({ reason: 'dns_failure' });
  });
});

/**
 * A response that records whether the code under test destroyed it.
 *
 * `destroyed` is the assertion for the body cap: a real stream stops producing
 * once destroyed, so a fake that keeps emitting would let a version with no cap
 * pass by never being stopped.
 */
interface FakeResponse extends EventEmitter {
  statusCode: number;
  destroy: () => void;
  destroyed: boolean;
}

/**
 * A stand-in for `https.request` that never touches a network.
 *
 * `behave` is handed the response after the handler has seen it, so a test can
 * emit chunks, a status, or nothing at all. `fail` skips the response entirely
 * and emits on the request instead, which is where a refused lookup arrives.
 */
const fakeRequest = (
  behave: (response: FakeResponse) => void,
  fail?: { readonly event: 'timeout' | 'error'; readonly error?: Error },
) => {
  const outgoing = Object.assign(new EventEmitter(), {
    destroy: () => undefined,
    end: () => undefined,
  });

  return (_options: unknown, handler?: (response: FakeResponse) => void) => {
    outgoing.end = () => {
      queueMicrotask(() => {
        if (fail !== undefined) {
          outgoing.emit(fail.event, fail.error);

          return;
        }

        const response: FakeResponse = Object.assign(new EventEmitter(), {
          statusCode: 200,
          destroyed: false,
          destroy: () => {
            response.destroyed = true;
          },
        });

        handler?.(response);
        behave(response);
      });
    };

    return outgoing;
  };
};

const fetchWith = async (
  request: ReturnType<typeof fakeRequest>,
  url = 'https://winery.example/.well-known/somm-verify-abc.txt',
) =>
  guardedFetch(url, {
    resolveAll: answering(PUBLIC),
    request: request as never,
  });

describe('the request itself', () => {
  it('reads a small body', async () => {
    const request = fakeRequest((response) => {
      response.emit('data', Buffer.from('nonce-value'));
      response.emit('end');
    });

    await expect(fetchWith(request)).resolves.toMatchObject({ status: 200, body: 'nonce-value' });
  });

  it('refuses a redirect before reading a byte', async () => {
    /*
     * **The other half of the rebinding attack.** A 302 to an internal address
     * gets its own connection, and following it would undo every check above
     * because this code would not be the thing making that connection.
     */
    let emitted = 0;
    const request = fakeRequest((response) => {
      if (response.destroyed) return;

      emitted += 1;
      response.emit('data', Buffer.from('should never be read'));
    });

    /* The status has to be set before the handler reads it, which is what a
     * real response does and what `behave` is too late for. */
    const redirecting = (options: unknown, handler?: (response: FakeResponse) => void) =>
      request(options, (response) => {
        response.statusCode = 302;
        handler?.(response);
      });

    await expect(fetchWith(redirecting)).rejects.toMatchObject({
      reason: 'blocked_redirect',
    });

    /* **Torn down, not merely ignored.** A refusal that leaves the stream open
     * has still fetched whatever the host wanted to send us. */
    expect(emitted).toBe(0);
  });

  it('refuses a body larger than the cap, without buffering it all', async () => {
    /*
     * Checked as it arrives. A cap enforced on a buffered body is a cap that
     * has already spent the memory it exists to save.
     */
    let written = 0;
    const request = fakeRequest((response) => {
      for (let chunk = 0; chunk < 10 && !response.destroyed; chunk += 1) {
        written += 1;
        response.emit('data', Buffer.alloc(MAX_BODY_BYTES));
      }

      if (!response.destroyed) response.emit('end');
    });

    await expect(fetchWith(request)).rejects.toMatchObject({ reason: 'too_large' });
    /* It stopped early rather than reading all ten. */
    expect(written).toBeLessThan(10);
  });

  it('accepts a body of exactly the cap', async () => {
    /* The cap is a maximum, not a limit one short of it — and `>` against `>=`
     * is the off-by-one nothing else here would notice. */
    const request = fakeRequest((response) => {
      response.emit('data', Buffer.alloc(MAX_BODY_BYTES, 'a'));
      response.emit('end');
    });

    await expect(fetchWith(request)).resolves.toMatchObject({ status: 200 });
  });

  it('times out a host that accepts and never answers', async () => {
    const request = fakeRequest(() => undefined, { event: 'timeout' });

    await expect(fetchWith(request)).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('reports a connection failure as a network failure', async () => {
    const request = fakeRequest(() => undefined, {
      event: 'error',
      error: new Error('ECONNREFUSED'),
    });

    await expect(fetchWith(request)).rejects.toMatchObject({ reason: 'network' });
  });

  it('keeps the lookup own reason when the lookup is what refused', async () => {
    /* `blocked_address` is far more useful in a log than `network`, and the
     * refusal arrives as an error on the request. */
    const request = fakeRequest(() => undefined, {
      event: 'error',
      error: new GuardedFetchRefused('blocked_address'),
    });

    await expect(fetchWith(request)).rejects.toMatchObject({ reason: 'blocked_address' });
  });

  it('refuses a response with no status at all', async () => {
    /* `statusCode` is optional on an `IncomingMessage`, and defaulting it to
     * zero is how a response nothing can be decided from becomes a 200. */
    const request = fakeRequest((response) => {
      response.emit('end');
    });

    const statusless = (options: unknown, handler?: (response: FakeResponse) => void) =>
      request(options, (response) => {
        (response as { statusCode: number | undefined }).statusCode = undefined;
        handler?.(response);
      });

    await expect(fetchWith(statusless)).rejects.toMatchObject({ reason: 'network' });
  });

  it('reports a body that fails part way through as a network failure', async () => {
    const request = fakeRequest((response) => {
      response.emit('data', Buffer.from('half a '));
      response.emit('error', new Error('ECONNRESET'));
    });

    await expect(fetchWith(request)).rejects.toMatchObject({ reason: 'network' });
  });

  it('settles once, whatever else the response goes on to emit', async () => {
    /* Every path here is reachable twice — a stream that errors after ending,
     * a timeout after a body — and a promise that settles twice is a bug that
     * hides whichever outcome came second. */
    const request = fakeRequest((response) => {
      response.emit('data', Buffer.from('nonce-value'));
      response.emit('end');
      response.emit('end');
      response.emit('error', new Error('too late'));
    });

    await expect(fetchWith(request)).resolves.toMatchObject({ body: 'nonce-value' });
  });

  it('brings its own client when it is not handed one', async () => {
    /* No `request` and no `resolveAll`: the defaults are what production uses,
     * and this refuses before either is reached for. */
    await expect(guardedFetch('http://winery.example/x')).rejects.toMatchObject({
      reason: 'blocked_scheme',
    });
  });

  it('holds the timeout and the cap where the row put them', () => {
    expect(GUARDED_TIMEOUT_MS).toBe(5000);
    expect(MAX_BODY_BYTES).toBe(1024);
  });
});

describe('the options the client is handed', () => {
  /**
   * **The most important assertion in this file.** Every other request case
   * injects the client, so the guarded `lookup` is never invoked — which means
   * a version of `guardedFetch` that forgot to wire it in would pass all of
   * them. These two cases are what make the rest mean anything.
   */
  const optionsFor = async (url: string): Promise<Record<string, unknown>> => {
    let seen: Record<string, unknown> = {};
    const request = fakeRequest((response) => {
      response.emit('end');
    });

    await guardedFetch(url, {
      resolveAll: answering(PUBLIC),
      request: ((options: Record<string, unknown>, handler?: (response: FakeResponse) => void) => {
        seen = options;

        return request(options, handler);
      }) as never,
    });

    return seen;
  };

  it('carries the guarded lookup, which is where the whole defence lives', async () => {
    const { lookup } = await optionsFor('https://winery.example/x');

    expect(typeof lookup).toBe('function');

    /* Not just present — it is the one that refuses. */
    const refused = await new Promise<Error | null>((done) => {
      (lookup as LookupFn)('winery.example', {}, (error) => {
        done(error);
      });
    });

    expect(refused).toBeNull();
  });

  it('gives the lookup the resolver it was handed, rebinding answer and all', async () => {
    let seen: Record<string, unknown> = {};
    const request = fakeRequest((response) => {
      response.emit('end');
    });

    await expect(
      guardedFetch('https://winery.example/x', {
        resolveAll: answering(PRIVATE),
        request: ((
          options: Record<string, unknown>,
          handler?: (response: FakeResponse) => void,
        ) => {
          seen = options;

          return request(options, handler);
        }) as never,
      }),
    ).resolves.toBeDefined();

    const refused = await new Promise<Error | null>((done) => {
      (seen.lookup as LookupFn)('winery.example', {}, (error) => {
        done(error);
      });
    });

    expect(refused).toMatchObject({ reason: 'blocked_address' });
  });

  it('sends nothing tenant-supplied, and always to 443', async () => {
    /*
     * **A header is a channel.** Anything of the tenant's that ends up in one
     * turns this into a way to send their data to a host of their choosing —
     * so the set is fixed, and this asserts the whole set rather than the
     * absence of any particular name.
     */
    const options = await optionsFor('https://winery.example/.well-known/x.txt?a=1');

    expect(options).toMatchObject({
      method: 'GET',
      host: 'winery.example',
      port: 443,
      path: '/.well-known/x.txt?a=1',
      timeout: GUARDED_TIMEOUT_MS,
    });
    expect(options.headers).toStrictEqual({
      accept: 'text/plain',
      'user-agent': 'catalogorosso-verifier',
    });
  });
});

describe('the URL it is given', () => {
  const refuse = async (url: string) =>
    guardedFetch(url, {
      resolveAll: answering(PUBLIC),
      request: fakeRequest((response) => {
        response.emit('end');
      }) as never,
    });

  it.each([
    ['http://winery.example/x', 'blocked_scheme', 'plain http'],
    ['ftp://winery.example/x', 'blocked_scheme', 'another protocol entirely'],
    ['file:///etc/passwd', 'blocked_scheme', 'the local filesystem'],
    ['https://winery.example:22/x', 'blocked_port', 'a port scan with our source address'],
    ['https://winery.example:8080/x', 'blocked_port', 'likewise'],
    ['not a url', 'blocked_scheme', 'not a URL at all'],
  ])('refuses %s as %s (%s)', async (url, reason) => {
    await expect(refuse(url)).rejects.toMatchObject({ reason });
  });

  it('accepts an explicit 443, which the parser makes the same as none', async () => {
    /* `new URL()` drops a scheme's default port, so `:443` never reaches the
     * check as anything other than an empty string — which is why the check
     * compares against `''` alone and not against `'443'` as well. */
    const request = fakeRequest((response) => {
      response.emit('end');
    });

    await expect(
      guardedFetch('https://winery.example:443/x', {
        resolveAll: answering(PUBLIC),
        request: request as never,
      }),
    ).resolves.toMatchObject({ status: 200 });
  });
});
