import { describe, expect, it } from 'vitest';

import {
  apiHeadersPolicyArgs,
  DASHBOARD_CSP,
  DASHBOARD_CSP_DIRECTIVES,
  dashboardHeadersPolicyArgs,
  HSTS_MAX_AGE_SECONDS,
  PERMISSIONS_POLICY,
} from '../headers';

/**
 * The CloudFront security headers, per surface (P4-12).
 *
 * The policies are data, so they are asserted as data here. That the browser
 * then *enforces* the dashboard's CSP against the real bundle is the browser
 * suite's to prove, and it serves the dashboard under this same string.
 */

const directive = (name: string): string | undefined =>
  DASHBOARD_CSP_DIRECTIVES.find((line) => line.split(' ')[0] === name);

describe("the dashboard's CSP", () => {
  it('never allows inline code or eval, anywhere', () => {
    expect(DASHBOARD_CSP).not.toContain('unsafe-inline');
    expect(DASHBOARD_CSP).not.toContain('unsafe-eval');
    expect(DASHBOARD_CSP).not.toContain('unsafe-hashes');
  });

  it('runs scripts and styles from its own origin only', () => {
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(directive('style-src')).toBe("style-src 'self'");
  });

  it('starts from nothing, so a directive forgotten is a directive denied', () => {
    expect(DASHBOARD_CSP_DIRECTIVES[0]).toBe("default-src 'none'");
  });

  it('talks to its own origin only, which is where the API is', () => {
    /* A script that got in anyway cannot post the session anywhere else. */
    expect(directive('connect-src')).toBe("connect-src 'self'");
  });

  it('closes the lesser-known ways in', () => {
    expect(directive('base-uri')).toBe("base-uri 'none'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('form-action')).toBe("form-action 'self'");
  });

  it('names each directive once', () => {
    const names = DASHBOARD_CSP_DIRECTIVES.map((line) => line.split(' ')[0]);

    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the dashboard policy', () => {
  const { securityHeadersConfig, customHeadersConfig, removeHeadersConfig } =
    dashboardHeadersPolicyArgs();

  it('sends that CSP, over whatever the origin says', () => {
    expect(securityHeadersConfig.contentSecurityPolicy).toEqual({
      contentSecurityPolicy: DASHBOARD_CSP,
      override: true,
    });
  });

  it('is never framed', () => {
    expect(securityHeadersConfig.frameOptions.frameOption).toBe('DENY');
  });

  it('sends HSTS for two years, with subdomains, fit for the preload list', () => {
    expect(securityHeadersConfig.strictTransportSecurity).toMatchObject({
      accessControlMaxAgeSec: HSTS_MAX_AGE_SECONDS,
      includeSubdomains: true,
      preload: true,
    });
    /* The preload list refuses anything under a year. */
    expect(HSTS_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(31_536_000);
  });

  it('sends nosniff and a referrer policy that keeps paths on this origin', () => {
    expect(securityHeadersConfig.contentTypeOptions.override).toBe(true);
    expect(securityHeadersConfig.referrerPolicy.referrerPolicy).toBe(
      'strict-origin-when-cross-origin',
    );
  });

  it('turns off every powerful feature', () => {
    expect(customHeadersConfig.items).toEqual([
      { header: 'Permissions-Policy', value: PERMISSIONS_POLICY, override: true },
    ]);
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
      expect(PERMISSIONS_POLICY).toContain(`${feature}=()`);
    }
  });

  it('drops the Server banner', () => {
    expect(removeHeadersConfig.items).toEqual([{ header: 'Server' }]);
  });
});

describe('the API policy', () => {
  const policy = apiHeadersPolicyArgs();

  it('sends HSTS and nosniff', () => {
    expect(policy.securityHeadersConfig.strictTransportSecurity.preload).toBe(true);
    expect(policy.securityHeadersConfig.contentTypeOptions.override).toBe(true);
  });

  it('never sends a framing header, because the widget is embedded by design', () => {
    expect(policy.securityHeadersConfig).not.toHaveProperty('frameOptions');
    expect(policy.securityHeadersConfig).not.toHaveProperty('contentSecurityPolicy');
    expect(JSON.stringify(policy)).not.toContain('frame-ancestors');
  });

  it('drops the Server banner', () => {
    expect(policy.removeHeadersConfig.items).toEqual([{ header: 'Server' }]);
  });
});
