/// <reference path="../.sst/platform/config.d.ts" />

import { appMigratePassword, appRwPassword, database } from './database';

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
const connectionUrl = (user: $util.Input<string>, password: $util.Input<string>) =>
  $interpolate`postgres://${user}:${password}@${database.host}:${database.port}/${database.database}?sslmode=require`;

/**
 * What the application connects as: `app_rw` (P0-21a).
 *
 * This used to be built from `database.username`/`database.password` — the RDS
 * master, which holds `rds_superuser`. A superuser bypasses RLS outright, so
 * every policy P0-37 writes would have been inert in production while the
 * whole test suite stayed green, because the suite connects as `app_rw` and
 * production did not. The verification path and the deployed path differed in
 * exactly the dimension being verified.
 */
export const databaseUrl = secureParameter(
  'DatabaseUrl',
  'database/url',
  connectionUrl('app_rw', appRwPassword.result),
);

/**
 * The master credentials, kept as their own parameter and read by nothing at
 * runtime.
 *
 * Bootstrap needs them — `CREATE ROLE` and `CREATE EXTENSION` require
 * privileges `app_migrate` does not have — and a human needs them when
 * everything else has failed. Both are deploy-time and break-glass uses, which
 * is why this is a separate path that `parameterReadPermissions` refuses to
 * grant rather than a value any function can reach.
 */
export const databaseMasterUrl = secureParameter(
  'DatabaseMasterUrl',
  'database/master_url',
  connectionUrl(database.username, database.password),
);

/**
 * The role passwords, for the deploy path that applies bootstrap and
 * migrations (P0-21b).
 *
 * Bootstrap reads them as session GUCs rather than interpolating them into
 * SQL, so the values never appear in a logged statement.
 */
export const appRwPasswordParameter = secureParameter(
  'AppRwPassword',
  'database/app_rw_password',
  appRwPassword.result,
);

export const appMigratePasswordParameter = secureParameter(
  'AppMigratePassword',
  'database/app_migrate_password',
  appMigratePassword.result,
);

/**
 * Paths that exist for the deploy path and for break-glass, and that no
 * application function may be granted.
 *
 * Enforced at synth time rather than reviewed: a function asking for one is a
 * mistake that should stop the deploy, not appear in a diff someone skims.
 * `database/app_rw_password` is deliberately absent — it is the same secret
 * already inside `database/url`, which functions legitimately read, so listing
 * it would imply a boundary that does not exist.
 */
const DEPLOY_ONLY_PARAMETERS: ReadonlySet<string> = new Set([
  'database/master_url',
  'database/app_migrate_password',
]);

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
export const parameterReadPermissions = (names: readonly string[]) => {
  const deployOnly = names.filter((name) => DEPLOY_ONLY_PARAMETERS.has(name));

  if (deployOnly.length > 0) {
    throw new Error(
      `parameterReadPermissions: ${deployOnly.join(', ')} is deploy-time only. ` +
        'Granting it to a function would hand that function a connection that ' +
        'bypasses RLS (master) or can alter the schema (app_migrate).',
    );
  }

  return [
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
};

/**
 * Read access to the deploy-time parameters, for the migration runner only
 * (P0-21b).
 *
 * `parameterReadPermissions` throws on these paths by design, so the deploy
 * path needs its own grant rather than an exception threaded through the
 * function every application component calls. Two entry points, named
 * differently, is the point: granting the master connection is a deliberate
 * act that reads as one at the call site.
 *
 * Whatever uses this runs in-VPC. RDS is in private subnets with egress but no
 * inbound path, so a GitHub-hosted runner cannot reach the database — see
 * P0-21b for why that decision belongs to this task rather than to P0-40.
 */
export const deployParameterReadPermissions = () => [
  {
    actions: ['ssm:GetParameter', 'ssm:GetParameters'],
    resources: [
      'database/master_url',
      'database/app_rw_password',
      'database/app_migrate_password',
    ].map(
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
