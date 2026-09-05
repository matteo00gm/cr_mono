/// <reference path="../.sst/platform/config.d.ts" />

import { api } from './api';
import { isProtectedStage } from './stage';

/**
 * CloudFront CDN and static assets infrastructure (P0-17).
 *
 * A single distribution serves the dashboard SPA, the embeddable widget
 * bundles, and routes API requests to Lambda Function URLs (§5.1).
 *
 * This skeleton provisions the distribution, the dashboard S3 bucket with
 * Origin Access Control (OAC, replacing legacy OAI), and default SPA routing
 * error responses.
 */

// S3 bucket hosting the static dashboard SPA
export const dashboardBucket = new aws.s3.BucketV2('DashboardBucket', {
  // Never on a stage holding real data: forceDestroy lets a teardown delete a
  // non-empty bucket, which is the same class of mistake `removal: retain`
  // and RDS deletionProtection guard against elsewhere.
  forceDestroy: !isProtectedStage($app.stage),
});

// Block all public access to the S3 bucket; access is allowed only via CloudFront OAC
export const dashboardBucketPublicAccessBlock = new aws.s3.BucketPublicAccessBlock(
  'DashboardBucketPublicAccessBlock',
  {
    bucket: dashboardBucket.id,
    blockPublicAcls: true,
    blockPublicPolicy: true,
    ignorePublicAcls: true,
    restrictPublicBuckets: true,
  },
);

// Origin Access Control (OAC) for authenticating CloudFront requests to S3
export const dashboardOac = new aws.cloudfront.OriginAccessControl('DashboardOac', {
  description: 'OAC for sommelier dashboard S3 origin',
  originAccessControlOriginType: 's3',
  signingBehavior: 'always',
  signingProtocol: 'sigv4',
});

/**
 * Managed policies, looked up by name rather than pasted as ids (P0-17a).
 *
 * The ids are stable and public, and a lookup still reads better: `Managed-
 * CachingDisabled` says what it does where `4135ea2d-…` does not, and a typo in
 * a name fails at synth instead of producing a distribution that caches the API.
 */
const cachingDisabled = aws.cloudfront.getCachePolicyOutput({ name: 'Managed-CachingDisabled' });

/**
 * A lookup returns `string | undefined`, and `undefined` here would silently
 * produce a behaviour with no cache policy — which CloudFront fills in with its
 * legacy defaults, meaning the API would start caching. Failing at synth is the
 * whole reason for looking policies up by name instead of pasting ids.
 */
const requirePolicyId = (name: string, id: $util.Output<string | undefined> | undefined) =>
  $output(id).apply((value) => {
    if (value === undefined || value === '') {
      throw new Error(`CloudFront managed policy not found: ${name}`);
    }
    return value;
  });

/**
 * All viewer headers except `Host`.
 *
 * `Host` must not be forwarded to a Lambda Function URL: the origin routes on
 * it, and sending the distribution's domain instead of the function's breaks
 * the request. Everything else has to arrive — P2-08 needs `Origin` and P2-13
 * needs `Authorization`.
 */
const allViewerExceptHost = aws.cloudfront.getOriginRequestPolicyOutput({
  name: 'Managed-AllViewerExceptHostHeader',
});

/**
 * Function bodies are inline rather than read from a file.
 *
 * Reading would need a path resolved at synth time, and every candidate is a
 * gamble that only fails during a deploy: `$cli.paths.root` is undocumented and
 * absent from the generated typings, and `process.cwd()` assumes SST was
 * invoked from the project root. Two short functions are not worth that.
 */
const cloudfrontFunction = (name: string, comment: string, code: string) =>
  new aws.cloudfront.Function(name, {
    runtime: 'cloudfront-js-2.0',
    comment,
    publish: true,
    code,
  });

/**
 * SPA routing, replacing the distribution-wide `customErrorResponses`.
 *
 * `customErrorResponses` applies to every behaviour, not to the one that wants
 * it — so once API paths joined this distribution, every genuine API 404 would
 * have become a 200 carrying dashboard HTML. That silently breaks §3.5's "a
 * cross-tenant id returns 404", in the direction that looks like success. P0-17
 * recorded the hazard as a warning for whoever added the API origin; this is
 * that person removing it.
 *
 * A function is attached per behaviour, so the API cannot be affected by it.
 * Rewriting on the way *in* also beats mapping errors on the way out: S3 then
 * returns 200 for a request it can serve, so there is no error to map and no
 * 403/404 masking to reason about.
 */
const spaRewrite = cloudfrontFunction(
  'SpaRewrite',
  'Rewrites extensionless paths to /index.html for client-side routing',
  `function handler(event) {
  var request = event.request;

  // Anything with a file extension is a real asset — let S3 answer it,
  // including answering 404 when it genuinely is missing.
  if (request.uri.indexOf('.') !== -1) {
    return request;
  }

  // Everything else is a client-side route: /settings, /products/123.
  request.uri = '/index.html';
  return request;
}`,
);

/**
 * Pins `X-Forwarded-For` to the viewer address CloudFront saw.
 *
 * Attached to every API behaviour. Without it a client-supplied
 * `X-Forwarded-For` makes CloudFront send a two-entry list, Better Auth
 * resolves no IP at all, and every caller shares one rate-limit bucket — so one
 * attacker can lock out every user.
 *
 * The mechanism: Better Auth reads `x-forwarded-for`, and its `getIPFromHeader`
 * returns **null** when the header carries more than one entry. CloudFront
 * *appends* the viewer address to any client-supplied `X-Forwarded-For`, so a
 * caller who sends their own header produces exactly that two-entry list. The
 * header is attacker-controlled and its effect is on which bucket the attacker
 * is counted in — which is why this overwrites rather than trusting.
 */
const viewerIp = cloudfrontFunction(
  'ViewerIp',
  'Overwrites X-Forwarded-For with the address CloudFront observed',
  `function handler(event) {
  // Overwrite, never append: this makes the value unforgeable rather than
  // merely usually-correct, and the origin needs no trusted-proxy list to keep
  // current. event.viewer.ip is set by CloudFront and cannot be influenced by
  // the request.
  event.request.headers['x-forwarded-for'] = { value: event.viewer.ip };
  return event.request;
}`,
);

/**
 * The API origin: the Lambda Function URL created in `infra/api.ts` (P0-54).
 *
 * `api.url` is a full URL and CloudFront wants a bare domain, hence the parse.
 * A Function URL is HTTPS-only, so `originProtocolPolicy` is not a preference.
 */
const apiOriginId = 'api-lambda';
const apiOriginDomain = api.url.apply((url) => new URL(url).hostname);

/** Shared by both API behaviours; they differ only in caching and timeout. */
const apiBehaviourBase = {
  targetOriginId: apiOriginId,
  viewerProtocolPolicy: 'redirect-to-https',
  // The API is not a cache. `cachedMethods` still has to be a subset of
  // `allowedMethods`, and CloudFront requires GET/HEAD in it even when the
  // attached policy disables caching entirely.
  allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
  cachedMethods: ['GET', 'HEAD'],
  cachePolicyId: requirePolicyId('Managed-CachingDisabled', cachingDisabled.id),
  originRequestPolicyId: requirePolicyId(
    'Managed-AllViewerExceptHostHeader',
    allViewerExceptHost.id,
  ),
  functionAssociations: [{ eventType: 'viewer-request', functionArn: viewerIp.arn }],
};

// Main CloudFront Distribution
export const distribution = new aws.cloudfront.Distribution('Cdn', {
  enabled: true,
  isIpv6Enabled: true,
  defaultRootObject: 'index.html',
  priceClass: 'PriceClass_100', // US, Canada, Europe (cheapest tier)

  origins: [
    {
      originId: 'dashboard-s3',
      domainName: dashboardBucket.bucketRegionalDomainName,
      originAccessControlId: dashboardOac.id,
    },
    {
      originId: apiOriginId,
      domainName: apiOriginDomain,
      customOriginConfig: {
        httpPort: 80,
        httpsPort: 443,
        // A Function URL is HTTPS-only; there is nothing to negotiate.
        originProtocolPolicy: 'https-only',
        originSslProtocols: ['TLSv1.2'],
        /*
         * 30s, the default, stated because P0-17a turns on it. The general API
         * Lambda times out at 10s (`infra/api.ts`), so this is slack rather
         * than a budget — the streaming behaviour below raises it for the one
         * path that needs it.
         */
        originReadTimeout: 30,
        originKeepaliveTimeout: 5,
      },
    },
  ],

  defaultCacheBehavior: {
    targetOriginId: 'dashboard-s3',
    viewerProtocolPolicy: 'redirect-to-https',
    allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
    cachedMethods: ['GET', 'HEAD'],
    compress: true,
    forwardedValues: {
      queryString: false,
      cookies: { forward: 'none' },
    },
    minTtl: 0,
    defaultTtl: 86400,
    maxTtl: 31536000,

    // Scoped to this behaviour, which is the entire reason it replaces
    // `customErrorResponses` — see the function's own file.
    functionAssociations: [{ eventType: 'viewer-request', functionArn: spaRewrite.arn }],
  },

  /**
   * Ordered by precedence, most specific first — CloudFront takes the first
   * match, not the best one.
   *
   * **A behaviour added later must be inserted, not appended.** P3 serves the
   * widget bundles (`/v1/w.js`, `/v1/widget-*.js`) from S3, and those patterns
   * are more specific than `/v1/*` — appended, they would never match, and the
   * bundles would be served by the API Lambda as JSON 404s.
   */
  orderedCacheBehaviors: [
    {
      /*
       * The chat path, and the reason P0-17a exists.
       *
       * CloudFront buffers origin responses by default, which defeats response
       * streaming entirely — a caching behaviour has to buffer, because it has
       * to compute the object it would cache. The symptom is "the widget feels
       * slow", which is easy to misattribute to the model, so this gets its own
       * behaviour rather than relying on the general rule below.
       */
      ...apiBehaviourBase,
      pathPattern: '/v1/widget/chat',

      // Compression also buffers: gzip needs the body to compress it.
      compress: false,

      /*
       * **The origin read timeout is not set here, and cannot be.**
       *
       * P0-17a lists it beside the cache policy and compression as though all
       * three were behaviour properties. `originReadTimeout` is a property of
       * the *origin* — so a behaviour cannot raise it without its own origin,
       * and every behaviour sharing this one shares its 30s.
       *
       * That is fine today: the only origin is the BUFFERED function, which
       * times out at 10s, so 30s is slack. **P2-29 must add a second origin**
       * for the RESPONSE_STREAM function with `originReadTimeout: 60` — the
       * ceiling without a quota increase — and repoint this behaviour at it. It
       * needs a separate origin anyway, being a separate Function URL.
       *
       * P2-29 must also cap total handler time below that 60s, so a timeout
       * surfaces as a clean SSE `error` event rather than an opaque CloudFront
       * 504 arriving mid-stream.
       */
    },
    {
      // Everything else on the API. Same origin, same policies; it caches
      // nothing and compresses normally.
      ...apiBehaviourBase,
      pathPattern: '/v1/*',
      compress: true,
    },
  ],

  /*
   * `customErrorResponses` is deliberately absent (P0-17a).
   *
   * It used to map 403/404 to 200 `/index.html` for the SPA. It is
   * distribution-wide rather than per-behaviour, so the moment API paths joined
   * this distribution every genuine API 404 would have become a 200 carrying
   * dashboard HTML — silently breaking §3.5's "a cross-tenant id returns 404",
   * and breaking it in the direction that looks like success. P0-17 recorded
   * the hazard; the `SpaRewrite` function above replaces it with something
   * scoped to the one behaviour that wants it.
   */

  restrictions: {
    geoRestriction: {
      restrictionType: 'none',
    },
  },

  viewerCertificate: {
    cloudfrontDefaultCertificate: true,
  },
});

// Bucket policy granting CloudFront read access to the S3 bucket via OAC
export const dashboardBucketPolicy = new aws.s3.BucketPolicy('DashboardBucketPolicy', {
  bucket: dashboardBucket.id,
  policy: $interpolate`{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "AllowCloudFrontServicePrincipalReadOnly",
        "Effect": "Allow",
        "Principal": {
          "Service": "cloudfront.amazonaws.com"
        },
        "Action": "s3:GetObject",
        "Resource": "${dashboardBucket.arn}/*",
        "Condition": {
          "StringEquals": {
            "AWS:SourceArn": "${distribution.arn}"
          }
        }
      }
    ]
  }`,
});
