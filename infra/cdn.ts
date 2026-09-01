/// <reference path="../.sst/platform/config.d.ts" />

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
  },

  /*
   * SPA client-side routing: map 403/404 from S3 back to index.html with 200.
   *
   * WARNING for whoever adds the API origin. `customErrorResponses` is
   * distribution-wide, not per-behaviour, so once API paths are served from
   * this distribution every genuine API 404 also becomes a 200 carrying the
   * dashboard HTML. That silently breaks P4-15, whose whole point is that a
   * cross-tenant id returns 404 — and it would break it in the direction that
   * looks like success. Either serve the API from its own distribution, or
   * move SPA routing to a CloudFront Function scoped to the S3 behaviour.
   */
  customErrorResponses: [
    {
      errorCode: 403,
      responseCode: 200,
      responsePagePath: '/index.html',
      errorCachingMinTtl: 0,
    },
    {
      errorCode: 404,
      responseCode: 200,
      responsePagePath: '/index.html',
      errorCachingMinTtl: 0,
    },
  ],

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
