/**
 * The security headers CloudFront adds, per surface (P4-12).
 *
 * Pure, with no SST globals, so `infra/test/headers.test.ts` asserts the
 * policies and the browser suite serves the dashboard under the very CSP
 * written here — a test that enforced a copy would pass while the copy drifted.
 *
 * **Two policies, because the surfaces want opposite things from framing.** The
 * dashboard is never framed by anybody; the widget is embedded in sellers'
 * pages by design, so nothing on `/v1/*` may say `X-Frame-Options`.
 */

/**
 * The dashboard's CSP, one directive per line so a diff shows which one moved.
 *
 * **No `unsafe-inline`, and no nonce either** *(deviation from "nonce-based")*.
 * A nonce has to be minted per response, and the dashboard is a static SPA
 * CloudFront serves from S3 — nothing runs per response to mint one. It turns
 * out not to need one: Vite emits the bundle as external files, the built
 * `index.html` carries no inline script, style or handler (asserted in the
 * dashboard's bundle test), and Preact writes `style={…}` through the CSSOM,
 * which `style-src` does not govern. `'self'` alone is stricter than a nonce,
 * which would still admit any inline script that learned it.
 *
 * `img-src https:` is the one widening, and deliberate: catalogue images live
 * on sellers' own hosts. An image cannot run anything.
 */
export const DASHBOARD_CSP_DIRECTIVES: readonly string[] = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
];

export const DASHBOARD_CSP = DASHBOARD_CSP_DIRECTIVES.join('; ');

/**
 * Two years, with subdomains and `preload` — the preload list's own floor is
 * one year. Only meaningful once the custom domain exists (P0-17a); harmless on
 * the CloudFront default domain until then.
 */
export const HSTS_MAX_AGE_SECONDS = 63_072_000;

/** Every powerful feature, off: a catalogue console needs none of them. */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'browsing-topics=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

const strictTransportSecurity = {
  accessControlMaxAgeSec: HSTS_MAX_AGE_SECONDS,
  includeSubdomains: true,
  preload: true,
  override: true,
};

/**
 * `Server` names the software, which is a head start for nobody but an
 * attacker. S3 sends `AmazonS3`; removing it costs nothing.
 */
const removeServer = { items: [{ header: 'Server' }] };

/** The default behaviour: the dashboard SPA from S3. */
export const dashboardHeadersPolicyArgs = () => ({
  comment: 'Dashboard SPA: strict CSP, no framing, HSTS preload (P4-12)',
  securityHeadersConfig: {
    contentSecurityPolicy: { contentSecurityPolicy: DASHBOARD_CSP, override: true },
    contentTypeOptions: { override: true },
    frameOptions: { frameOption: 'DENY', override: true },
    referrerPolicy: { referrerPolicy: 'strict-origin-when-cross-origin', override: true },
    strictTransportSecurity,
  },
  customHeadersConfig: {
    items: [{ header: 'Permissions-Policy', value: PERMISSIONS_POLICY, override: true }],
  },
  removeHeadersConfig: removeServer,
});

/**
 * Every `/v1/*` behaviour: HSTS and `nosniff`, and **no framing header at all**,
 * because the widget's responses are read by pages on sellers' own origins.
 * The API sets its own surface-specific headers too (`security-headers.ts`);
 * `override` here is for the two that must hold whatever the origin says.
 */
export const apiHeadersPolicyArgs = () => ({
  comment: 'API: HSTS and nosniff, never frame options (the widget is embedded) (P4-12)',
  securityHeadersConfig: {
    contentTypeOptions: { override: true },
    strictTransportSecurity,
  },
  removeHeadersConfig: removeServer,
});
