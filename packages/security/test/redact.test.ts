import { describe, expect, it } from 'vitest';

import {
  connectionStringFixture,
  jwtFixture,
  publishableKeyFixture,
  secretKeyFixture,
} from '@catalogorosso/testing';

import {
  REDACTED,
  redactLogObject,
  redactValue,
  SAFE_KEYS,
  scrubString,
  serialiseError,
} from '../src/redact.js';

/**
 * Log redaction (P0-56).
 *
 * **Every key-shaped fixture is assembled at runtime**, in
 * `@catalogorosso/testing`. A literal `sk_live_` followed by 24 characters
 * anywhere in this repo is found by the P0-08 gitleaks history scan — the
 * plan's own warning about a scanner flagging itself — and once pushed it
 * cannot be edited out.
 */

const secretKey = secretKeyFixture();
const publishableKey = publishableKeyFixture();
const jwt = jwtFixture();

describe('the key allowlist', () => {
  it('redacts a field nobody thought about', () => {
    /*
     * The point of the whole PR.
     *
     * A denylist protects the fields somebody remembered on the day they wrote
     * it. This asserts the opposite default: a key that has never been
     * considered — because it did not exist when this file was written — is
     * hidden rather than published. Every other assertion here is a special
     * case of this one.
     */
    const result = redactValue({ somethingInventedNextYear: 'whatever this turns out to be' });

    expect(result).toEqual({ somethingInventedNextYear: REDACTED });
  });

  it('keeps the key name, so the line still says what was there', () => {
    // A line reporting that a `password` field was present is far more use
    // than one that silently dropped it — the difference between "this payload
    // carried a credential" and "this payload looked empty".
    expect(redactValue({ password: 'hunter2' })).toEqual({ password: REDACTED });
  });

  it('redacts at every depth, not only the top level', () => {
    const result = redactValue({
      requestId: 'r1',
      // `err` is allowed, so the walk descends — and finds a key that is not.
      err: { type: 'Error', apiKey: secretKey },
    });

    expect(result).toEqual({ requestId: 'r1', err: { type: 'Error', apiKey: REDACTED } });
  });

  it('redacts inside arrays', () => {
    const result = redactValue({ err: [{ type: 'A', secret: 'x' }, { type: 'B' }] });

    expect(result).toEqual({ err: [{ type: 'A', secret: REDACTED }, { type: 'B' }] });
  });

  it('lets the request context through, or the logs are worthless', () => {
    // The redaction is only tolerable because the fields that make a line
    // useful survive it. If this fails, every log line is anonymous.
    const context = { requestId: 'r1', tenantId: 't1', userId: 'u1', route: '/v1/products/:id' };

    expect(redactValue(context)).toEqual(context);
  });

  it('holds nothing dangerous in the allowlist itself', () => {
    /*
     * A guard on the list rather than on the walk. Every entry governs that key
     * name at *every* depth for *every* caller, so one added carelessly for one
     * call site quietly opens it everywhere — `message` is the live example,
     * since a visitor's chat message is a `message` and that is PII.
     */
    for (const forbidden of ['message', 'code', 'email', 'name', 'token', 'key', 'password']) {
      expect(SAFE_KEYS.has(forbidden), forbidden).toBe(false);
    }
  });
});

describe('the value patterns', () => {
  it.each([
    ['a secret key', secretKey],
    ['a publishable key', publishableKey],
    ['a JWT', jwt],
    ['a bearer header', `Bearer ${jwt}`],
    ['an email address', 'matteo@cantina-colpetrone.it'],
    ['a connection string', connectionStringFixture()],
  ])('scrubs %s out of an allowed string', (_label, secret) => {
    /*
     * The second layer, and it is not redundant. An allowed key can still carry
     * a secret: `msg` is allowed, and `"failed with token sk_live_…"` is a line
     * somebody will write.
     */
    const scrubbed = scrubString(`before ${secret} after`);

    expect(scrubbed).toContain('before');
    expect(scrubbed).toContain('after');
    expect(scrubbed).toContain(REDACTED);
  });

  it('removes the password from a connection string and leaves it readable', () => {
    // Both orderings of the patterns hide the password; only one leaves a line
    // an engineer can still act on, which is why the pattern list is ordered.
    expect(scrubString(connectionStringFixture())).toBe(
      `postgres://${REDACTED}@db.internal:5432/sommelier`,
    );
  });

  it('leaves ordinary text alone', () => {
    /*
     * The other half of a scrubber being useful. An over-broad pattern redacts
     * the messages people actually read, and a log everyone has learned to
     * distrust is not doing its job — the same reasoning as the P0-08 rule
     * about false positives training people to ignore the gate.
     */
    const ordinary = 'imported 412 products for Cantina Còlpetrone in 1.8s';

    expect(scrubString(ordinary)).toBe(ordinary);
  });

  it('does not match a short truncated key from documentation', () => {
    // `pk_live_9f3a…` appears in the plan and in the integration docs. A
    // scrubber that mangled it would make the docs unreadable in every log
    // line that quoted them.
    expect(scrubString('pk_live_9f3a')).toBe('pk_live_9f3a');
  });
});

describe('serialiseError', () => {
  it('keeps type, message and stack — scrubbed', () => {
    /*
     * Errors take their own path rather than the key allowlist, because
     * `message` and `stack` are exactly the fields a log needs and exactly the
     * ones that cannot be allowlisted generally. A driver error routinely
     * quotes the connection string that failed, so both are scrubbed.
     */
    const error = new Error('connect failed: postgres://app_rw:hunter2@db.internal/x');
    const result = serialiseError(error) as { type: string; message: string; stack: string };

    expect(result.type).toBe('Error');
    expect(result.message).not.toContain('hunter2');
    expect(result.message).toContain('connect failed');
    expect(result.stack).not.toContain('hunter2');
  });

  it('follows the cause, where normaliseThrown puts the original', () => {
    // P0-55 wraps a thrown non-Error and hangs the original off `cause`, which
    // is then often the only description of what actually happened.
    const result = serialiseError(new Error('wrapper', { cause: new Error(secretKey) })) as {
      cause: { message: string };
    };

    expect(result.cause.message).toBe(REDACTED);
  });

  it('carries the domain kind, so a log line says which failure this was', () => {
    const error = Object.assign(new Error('Not found'), { kind: 'not_found' });

    expect(serialiseError(error)).toMatchObject({ kind: 'not_found' });
  });

  it('redacts a thrown non-Error rather than trusting it', () => {
    expect(serialiseError({ password: 'hunter2' })).toEqual({ password: REDACTED });
  });

  it('copes with an error carrying no stack', () => {
    // `Error.captureStackTrace` can be suppressed, and errors crossing a
    // structured-clone boundary arrive without one. A serializer that assumed
    // a stack would fail inside the error path, where nothing catches it.
    const error = new Error('no stack here');
    delete (error as { stack?: string }).stack;

    expect(serialiseError(error)).toMatchObject({ type: 'Error', stack: undefined });
  });
});

describe('scalars', () => {
  it.each([
    ['null', null],
    ['a number', 412],
    ['a boolean', true],
    ['undefined', undefined],
  ])('passes %s through untouched', (_label, value) => {
    // Only strings can carry a secret, and only objects have keys to check.
    // Everything else has to survive, or a log line loses its counters.
    expect(redactValue(value)).toBe(value);
  });
});

describe('redactLogObject', () => {
  it('is the same walk, typed for pino formatters.log', () => {
    // Exercised here rather than only through the API suite, because that one
    // imports the built package and so proves nothing about this source file.
    expect(redactLogObject({ requestId: 'r1', apiKey: secretKey })).toEqual({
      requestId: 'r1',
      apiKey: REDACTED,
    });
  });
});

describe('an Error nested inside a logged object', () => {
  it('takes the error path rather than the key allowlist', () => {
    /*
     * How the logger actually calls this: `logger.error({ err }, 'boom')`. The
     * allowlist would reduce an `Error` to a bare `{}` — `message` and `stack`
     * are not allowlisted keys, and deliberately so — which is why `redactAt`
     * recognises the instance and hands it to `serialiseError` instead.
     */
    const result = redactValue({
      requestId: 'r1',
      err: new Error(`connect failed: ${connectionStringFixture()}`),
    }) as { err: { type: string; message: string } };

    expect(result.err.type).toBe('Error');
    expect(result.err.message).toContain('connect failed');
    expect(result.err.message).not.toContain('hunter2');
  });
});

describe('structures that would otherwise crash the logger', () => {
  it('survives a cycle', () => {
    // A logger that throws on a self-referential object turns a log line into
    // an outage, and objects acquire back-references easily.
    const node: Record<string, unknown> = { requestId: 'r1' };
    node.err = node;

    expect(() => redactValue(node)).not.toThrow();
    expect(redactValue(node)).toEqual({ requestId: 'r1', err: '[circular]' });
  });

  it('does not mistake a repeated reference for a cycle', () => {
    // Only the current path is tracked. A shared child appearing twice in a
    // tree is ordinary, and reporting it as circular would lose real data.
    const shared = { type: 'shared' };

    expect(redactValue({ err: [shared, shared] })).toEqual({
      err: [{ type: 'shared' }, { type: 'shared' }],
    });
  });

  it('stops at a depth cap', () => {
    let deep: Record<string, unknown> = { type: 'bottom' };
    for (let i = 0; i < 20; i += 1) deep = { err: deep };

    expect(JSON.stringify(redactValue(deep))).toContain('[too deep]');
  });

  it('renders a Date rather than walking it', () => {
    const when = new Date('2026-09-05T00:00:00.000Z');

    expect(redactValue({ time: when })).toEqual({ time: '2026-09-05T00:00:00.000Z' });
  });
});
