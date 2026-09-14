import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { SPA_REWRITE_CODE, VIEWER_IP_CODE } from '../edge-functions.js';

/**
 * The two CloudFront Functions, run (P0-17a, A1).
 *
 * **Until these existed nothing had ever executed either function outside
 * CloudFront**, and both fail silently. A viewer-IP function that appended
 * instead of overwriting would still send a plausible header; Better Auth would
 * resolve no IP from the two-entry list and count every caller in one bucket,
 * so one attacker locks out every user. A rewrite that caught a path with an
 * extension would serve `index.html` for a missing bundle, and the console
 * would fail to boot with a syntax error about `<`.
 */

interface EdgeRequest {
  uri: string;
  headers: Record<string, { value: string } | undefined>;
}

interface EdgeEvent {
  request: EdgeRequest;
  viewer: { ip: string };
}

/**
 * Loads a function body the way the runtime does: a script that declares one
 * global `handler`, with nothing imported and nothing else in scope.
 */
const load = (code: string) =>
  new Function(`${code}\nreturn handler;`)() as (event: EdgeEvent) => EdgeRequest;

const VIEWER = '198.51.100.23';

const event = (uri: string, headers: EdgeRequest['headers'] = {}): EdgeEvent => ({
  request: { uri, headers },
  viewer: { ip: VIEWER },
});

describe('ViewerIp', () => {
  const handler = load(VIEWER_IP_CODE);

  it('replaces a client-supplied X-Forwarded-For with the address CloudFront saw', () => {
    const request = handler(
      event('/v1/dashboard/auth/sign-in/email', {
        'x-forwarded-for': { value: '203.0.113.7' },
      }),
    );

    expect(request.headers['x-forwarded-for']).toEqual({ value: VIEWER });
  });

  it('writes exactly one entry, which is the only shape Better Auth resolves an IP from', () => {
    const request = handler(
      event('/v1/dashboard/me', {
        'x-forwarded-for': { value: '203.0.113.7, 10.0.0.1' },
      }),
    );

    expect(request.headers['x-forwarded-for']?.value).not.toContain(',');
  });

  it('sets the header when the client sent none', () => {
    expect(handler(event('/v1/dashboard/me')).headers['x-forwarded-for']).toEqual({
      value: VIEWER,
    });
  });

  it('leaves every other header as it arrived', () => {
    const origin = { value: 'https://dashboard.example' };
    const cookie = { value: 'session=abc' };

    const request = handler(event('/v1/dashboard/me', { origin, cookie }));

    expect(request.headers.origin).toBe(origin);
    expect(request.headers.cookie).toBe(cookie);
  });
});

describe('SpaRewrite', () => {
  const handler = load(SPA_REWRITE_CODE);

  it.each(['/', '/catalogo', '/membri', '/products/123'])(
    'serves the console for the client-side route %s',
    (uri) => {
      expect(handler(event(uri)).uri).toBe('/index.html');
    },
  );

  it.each(['/index.html', '/assets/index-4f9a2c1b.js', '/assets/index-8d0e.css', '/favicon.ico'])(
    'leaves the asset %s for S3 to answer, including with a 404',
    (uri) => {
      expect(handler(event(uri)).uri).toBe(uri);
    },
  );

  it('serves the console for an invitation link, whatever token it carries', () => {
    /*
     * The rule is "a dot means a file", so a route segment containing a dot is
     * sent to S3 and 404s. Invitation links end in the token, and that is safe
     * only because `packages/core/src/invitations.ts` encodes it as base64url,
     * whose alphabet has no dot. Asserted here so that changing the encoding
     * fails in front of the rule it would break, rather than in a customer's
     * inbox.
     */
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const token = randomBytes(32).toString('base64url');

      expect(handler(event(`/invito/${token}`)).uri).toBe('/index.html');
    }
  });
});
