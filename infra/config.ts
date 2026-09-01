/// <reference path="../.sst/platform/config.d.ts" />

import { database } from './database';

/**
 * Parameter store and per-function IAM scoping (P0-15).
 *
 * Namespace is `/sommelier/<stage>/<name>` so one policy prefix can express
 * "this stage only", and a function's role can be narrowed further to the
 * handful of paths it actually reads.
 */
const PREFIX = `/sommelier/${$app.stage}`;

export const parameterPath = (name: string): string => `${PREFIX}/${name}`;

/**
 * `SecureString` under the AWS-managed `aws/ssm` key.
 *
 * `keyId` is deliberately omitted, which selects `aws/ssm`: free, against
 * $1/month for a customer-managed key, and sufficient because the value is
 * already encrypted at rest and the threat being addressed is a leaked
 * parameter path, not a compromised KMS boundary.
 */
const secureParameter = (logicalName: string, name: string, value: $util.Input<string>) =>
  new aws.ssm.Parameter(logicalName, {
    name: parameterPath(name),
    type: 'SecureString',
    value,
  });

/**
 * The database URL, mirrored out of the Secrets Manager secret SST creates.
 *
 * Mirrored rather than read directly (§P0-14): Secrets Manager bills per API
 * call, and a Lambda that reads its connection string on every cold start
 * across many containers pays for it repeatedly. SSM `GetParameter` is free.
 *
 * `sslmode=require` matches the `rds.force_ssl = 1` set in P0-14 — the server
 * would refuse a plaintext connection anyway, but failing in the client with a
 * clear message beats failing in the server with a generic one.
 */
export const databaseUrl = secureParameter(
  'DatabaseUrl',
  'database/url',
  $interpolate`postgres://${database.username}:${database.password}@${database.host}:${database.port}/${database.database}?sslmode=require`,
);

/**
 * IAM permissions granting read access to *specific* parameters only.
 *
 * The failure this prevents: one wildcard `ssm:GetParameter` on `*` means any
 * compromised function can read every secret in the account, so a bug in the
 * widget path yields the Stripe key. Callers pass the names they read; nothing
 * grants the prefix wholesale.
 *
 * The `kms:Decrypt` statement uses `resources: ['*']` narrowed by a
 * `kms:ViaService` condition rather than a key ARN. The `aws/ssm` managed key's
 * id is account- and region-specific and not known at synth time; the condition
 * restricts the grant to decryption performed by SSM on this function's behalf,
 * which is the property actually wanted.
 */
export const parameterReadPermissions = (names: readonly string[]) => [
  {
    actions: ['ssm:GetParameter', 'ssm:GetParameters'],
    resources: names.map(
      (name) =>
        $interpolate`arn:aws:ssm:${aws.getRegionOutput().name}:${aws.getCallerIdentityOutput().accountId}:parameter${parameterPath(name)}`,
    ),
  },
  {
    actions: ['kms:Decrypt'],
    resources: ['*'],
    conditions: [
      {
        test: 'StringEquals',
        variable: 'kms:ViaService',
        values: [$interpolate`ssm.${aws.getRegionOutput().name}.amazonaws.com`],
      },
    ],
  },
];
