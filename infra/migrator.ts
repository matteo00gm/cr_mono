/// <reference path="../.sst/platform/config.d.ts" />

import { deployParameterReadPermissions } from './config';
import { vpc } from './vpc';

/**
 * The deploy-time database path, as a one-shot function (P0-21b).
 *
 * **This was the gap a first deploy exposed.** `scripts/db-deploy.mjs` has
 * existed since P0-21b, tested, wired to nothing — so the `dev` stage came up
 * with an RDS instance holding no roles and no schema, and every request
 * touching data answered 500 with `password authentication failed for user
 * "app_rw"`. The plan said migrations were "applied by hand and by the test
 * fixtures, which is fine while no stage holds data". A stage now exists.
 *
 * **It is a separate function, and that is the security-relevant part.**
 * P0-21a refuses `database/master_url` and `database/app_migrate_password` to
 * every application function — one grants a connection that bypasses RLS, the
 * other can alter the schema. Folding this into `Api` would hand the request
 * path precisely those two privileges. `deployParameterReadPermissions()` was
 * written for this function and had no caller until now.
 *
 * **Not invoked automatically after deploy**, deliberately. SST has no
 * post-deploy hook that is guaranteed to run after the database is available
 * *and* to fail the deploy if the migration fails, and a migration that runs
 * silently on every `sst deploy` is how a schema change reaches production
 * before anybody has looked at it. It is one explicit command, in the runbook,
 * with output.
 */
export const migrator = new sst.aws.Function('Migrator', {
  handler: 'apps/migrator/src/index.handler',

  /*
   * In the VPC, because RDS is not reachable from anywhere else. The instance
   * sits in private subnets with egress but no inbound path — a GitHub-hosted
   * runner cannot reach it, and neither can a laptop, which is the outcome
   * worth designing against rather than working around.
   */
  vpc,

  /**
   * Five minutes, against an API function that gets ten seconds.
   *
   * Bootstrap and the migration chain are dozens of statements, and the first
   * run on an empty database creates every table, index and policy. The HNSW
   * index in `0011` is the slow one and it grows with the catalogue. A timeout
   * here does not corrupt anything — each migration is transactional and
   * Drizzle records what it applied — but it does mean a half-migrated schema
   * that the next invocation has to finish, so the number should be generous.
   */
  timeout: '5 minutes',
  memory: '512 MB',
  architecture: 'arm64',
  runtime: 'nodejs22.x',

  /*
   * The SQL, copied into the artifact.
   *
   * esbuild collapses `packages/db` into one file, so `deploy.ts`'s
   * package-relative default resolves to `/var/` inside the bundle and finds
   * nothing. `SQL_ROOT` below tells the handler where these landed; the two
   * must agree, and they are ten lines apart for that reason.
   */
  copyFiles: [
    { from: 'packages/db/bootstrap', to: 'sql/bootstrap' },
    { from: 'packages/db/migrations', to: 'sql/migrations' },
  ],

  environment: {
    SST_STAGE: $app.stage,
    SQL_ROOT: '/var/task/sql',
  },

  /*
   * The only grant of the deploy-time parameters in the whole application.
   * `parameterReadPermissions` throws on these paths at synth time, so this
   * being a different function name is the boundary — not a flag, not an
   * option, a second entry point that reads as a deliberate act at the call
   * site.
   */
  permissions: deployParameterReadPermissions(),
});
