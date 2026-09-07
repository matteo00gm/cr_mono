import process from 'node:process';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { applyBootstrap, applyMigrations, withRole } from '@catalogorosso/db';

/**
 * The deploy-time database path, as a one-shot Lambda (P0-21b).
 *
 * **Why this exists as its own function.** `scripts/db-deploy.mjs` has done
 * this work since P0-21b and was wired to nothing, so a deployed stage had an
 * RDS instance with no roles and no schema — every request touching data
 * answered 500 with `password authentication failed for user "app_rw"`, which
 * is what a first deploy actually produced.
 *
 * It cannot run from CI. RDS sits in private subnets with egress but no inbound
 * path, so a GitHub-hosted runner cannot reach the instance at all; nor can a
 * laptop, which is the outcome worth avoiding anyway — the alternative to this
 * function is somebody running `psql` against production by hand.
 *
 * **And it cannot be part of `apps/api`.** P0-21a refuses the master and
 * `app_migrate` parameters to every application function, because one grants a
 * connection that bypasses RLS and the other can alter the schema. Folding the
 * migration into the API would hand the request path exactly the two
 * privileges that rule exists to deny. A separate function means a separate
 * role, and `deployParameterReadPermissions()` — written for this and unused
 * until now — is the only place those paths are granted.
 *
 * **Credentials are read at invoke time, not injected.** The API function
 * carries `DATABASE_URL` in its environment, which is fine for `app_rw` and
 * would not be for master: an environment variable is readable by anyone
 * holding `lambda:GetFunctionConfiguration`, permanently, whether or not the
 * function ever runs. Fetching leaves the value in memory for the seconds an
 * invocation lasts.
 */

/** Parameter *names*, in `parameterPath` terms. The prefix is applied below. */
const NAMES = [
  'database/master_url',
  'database/app_rw_password',
  'database/app_migrate_password',
] as const;

/**
 * Where the deploy copied the SQL.
 *
 * The bundle collapses `packages/db` into one file, so the package-relative
 * default in `deploy.ts` would resolve to a directory that does not exist. The
 * infrastructure copies `bootstrap/` and `migrations/` into the artifact and
 * this is where it puts them; the two have to agree, and they are three lines
 * apart in `infra/database.ts`.
 */
/**
 * Empty is absent, not a value.
 *
 * `??` alone would accept `SQL_ROOT=""` and resolve the bootstrap directory to
 * `/bootstrap`, which exists nowhere — a silent wrong answer rather than the
 * default. An unset variable and one set to nothing mean the same thing here,
 * and a test asserting the fallback is what found the difference.
 */
const fromEnvironment = (name: string, fallback: string): string => {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? fallback : value;
};

const sqlRoot = (): string => fromEnvironment('SQL_ROOT', '/var/task/sql');
const stage = (): string => fromEnvironment('SST_STAGE', '');

export interface MigrateResult {
  readonly ok: boolean;
  readonly applied: 'bootstrap+migrations';
  readonly stage: string;
}

/**
 * Reads the three parameters in one call.
 *
 * `GetParameters` rather than three `GetParameter`s: one round trip, and — the
 * reason that matters — its `InvalidParameters` field names what was missing,
 * so a partial IAM grant fails with the path it could not read rather than with
 * an undefined value that turns into a connection string of `undefined`.
 */
interface Credentials {
  readonly masterUrl: string;
  readonly app_rw: string;
  readonly app_migrate: string;
}

const readParameters = async (stageName: string): Promise<Credentials> => {
  const ssm = new SSMClient({});
  const paths = NAMES.map((name) => `/sommelier/${stageName}/${name}`);

  const response = await ssm.send(new GetParametersCommand({ Names: paths, WithDecryption: true }));

  const invalid = response.InvalidParameters ?? [];
  if (invalid.length > 0) {
    throw new Error(
      `migrator: could not read ${invalid.join(', ')}. ` +
        'Check the parameter exists for this stage and that this function is ' +
        'granted deployParameterReadPermissions() — the application grant ' +
        'refuses these paths by design (P0-21a).',
    );
  }

  const values = new Map(
    (response.Parameters ?? []).map((parameter) => [parameter.Name ?? '', parameter.Value ?? '']),
  );

  /*
   * Resolved into a typed shape here rather than handed back as a map the
   * caller indexes. The difference is not style: an index lookup needs a `??`
   * fallback to satisfy `noUncheckedIndexedAccess`, and that fallback is an
   * empty string reaching a connection URL — the exact "not configured reads as
   * a default" failure P0-15's loader exists to prevent. Validating once and
   * returning three named strings means there is no fallback to get wrong.
   */
  const missing = paths.filter((path) => (values.get(path) ?? '') === '');
  if (missing.length > 0) {
    throw new Error(`migrator: ${missing.join(', ')} resolved empty`);
  }

  const at = (name: string): string => values.get(`/sommelier/${stageName}/${name}`) ?? '';

  return {
    masterUrl: at('database/master_url'),
    app_rw: at('database/app_rw_password'),
    app_migrate: at('database/app_migrate_password'),
  };
};

/**
 * Applies bootstrap as master, then migrations as `app_migrate`.
 *
 * The order and the roles are the whole of it, and neither is arbitrary.
 * Bootstrap runs as master because `CREATE ROLE` and `CREATE EXTENSION` need
 * privileges `app_migrate` does not have — and because `app_migrate` cannot
 * create itself. Migrations then run as `app_migrate` because **whoever runs a
 * migration owns the tables it creates**, and `FORCE ROW LEVEL SECURITY` does
 * not apply to a table's owner: run them as master and every policy in P0-37 is
 * silently inert for the role that owns the schema; run them as `app_rw` and
 * they are inert for the application itself.
 *
 * Idempotent, so re-running after every deploy is the intended usage rather
 * than a special case.
 */
export const handler = async (): Promise<MigrateResult> => {
  const stageName = stage();
  if (stageName === '') {
    // Without a stage the paths address `/sommelier//…`, which resolves to
    // nothing — and the failure should say why rather than arriving as three
    // invalid parameters.
    throw new Error('migrator: SST_STAGE is not set');
  }

  const { masterUrl, ...passwords } = await readParameters(stageName);
  const root = sqlRoot();
  const at = {
    bootstrapDir: `${root}/bootstrap`,
    migrationsDir: `${root}/migrations`,
  };

  console.log('migrator: applying bootstrap as master');
  await applyBootstrap(masterUrl, passwords, at);

  console.log('migrator: applying migrations as app_migrate');
  await applyMigrations(withRole(masterUrl, 'app_migrate', passwords.app_migrate), at);

  console.log('migrator: done');
  return { ok: true, applied: 'bootstrap+migrations', stage: stageName };
};
