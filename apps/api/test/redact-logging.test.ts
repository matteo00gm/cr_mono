import { REDACTED } from '@catalogorosso/security';
import { secretKeyFixture } from '@catalogorosso/testing';
import { pino, type Logger, type LoggerOptions } from 'pino';
import { describe, expect, it } from 'vitest';

import { loggerOptions } from '../src/middleware/logger.js';

/**
 * The redaction as the process logger is actually configured (P0-56).
 *
 * The rules themselves are tested in `packages/security`, where they live. What
 * is only observable here is the *wiring* — that pino runs them at all, and in
 * the two places where pino would otherwise route straight past them.
 *
 * Key-shaped fixtures are assembled at runtime in `@catalogorosso/testing`: a
 * literal `sk_live_` followed by 24 characters anywhere in this repo is found
 * by the P0-08 gitleaks history scan, which is the plan's own warning about a
 * scanner flagging itself.
 */

const secretKey = secretKeyFixture();

describe('the logger as configured', () => {
  const capturing = (): { lines: Record<string, unknown>[]; log: Logger } => {
    const lines: Record<string, unknown>[] = [];
    const options: LoggerOptions = { ...loggerOptions, level: 'trace' };
    const log = pino(options, {
      write: (chunk: string) => lines.push(JSON.parse(chunk) as Record<string, unknown>),
    });
    return { lines, log };
  };

  it('scrubs the message string, which formatters.log never sees', () => {
    /*
     * Confirmed by probing the pinned build: `msg` is assembled *after* the
     * formatter runs, so without the `logMethod` hook a
     * `logger.info('failed with token sk_live_…')` is published verbatim.
     */
    const { lines, log } = capturing();

    log.info(`failed with token ${secretKey}`);

    expect(lines[0]?.msg).toBe(`failed with token ${REDACTED}`);
  });

  it('redacts an unknown field on a real log call', () => {
    const { lines, log } = capturing();

    log.info({ requestId: 'r1', stripeCustomerId: 'cus_12345' }, 'charged');

    expect(lines[0]).toMatchObject({ requestId: 'r1', stripeCustomerId: REDACTED });
  });

  it('does not let pino default err serializer bypass the redaction', () => {
    /*
     * The bug this configuration exists to prevent, and it is not obvious.
     * `formatters.log` runs *before* serializers, and pino's default `err`
     * serializer then rewrites the key from the original `Error` — discarding
     * whatever the formatter produced. Left at its default, a connection
     * string in a driver error reaches CloudWatch in full.
     */
    const { lines, log } = capturing();

    log.error(
      { err: new Error('connect failed: postgres://app_rw:hunter2@db.internal/x') },
      'boom',
    );

    expect(JSON.stringify(lines[0])).not.toContain('hunter2');
    expect(JSON.stringify(lines[0])).toContain('connect failed');
  });
});
