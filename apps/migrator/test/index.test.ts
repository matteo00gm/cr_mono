import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The migration runner's parameter handling (P0-21b).
 *
 * **Only the parameter handling**, and that is the whole intent. What the
 * handler does after reading three values is `applyBootstrap` and
 * `applyMigrations`, which are asserted against real Postgres in
 * `packages/db/test/migration-reversibility.integration.test.ts` — including
 * the property that matters most, that a full rollback leaves the schema
 * byte-identical. Re-asserting that here against a fake would prove nothing
 * and would be the second place to update when it changes.
 *
 * What *is* worth pinning here is the failure path: a partial IAM grant has to
 * surface as the path it could not read. The alternative is `undefined`
 * interpolated into a connection string, which fails later, somewhere else,
 * with a message about a host that does not exist.
 */

const sent: unknown[] = [];
const state = {
  invalid: [] as string[],
  parameters: [] as { Name: string; Value: string }[],
};

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send(command: unknown): Promise<unknown> {
      sent.push(command);
      // Fields omitted when empty, which is what the SDK actually does — and
      // the reason the handler carries `?? []` fallbacks at all.
      return Promise.resolve({
        ...(state.invalid.length > 0 ? { InvalidParameters: state.invalid } : {}),
        ...(state.parameters.length > 0 ? { Parameters: state.parameters } : {}),
      });
    }
  },
  GetParametersCommand: class {
    public readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

const applied: string[] = [];
const locations: unknown[] = [];

vi.mock('@catalogorosso/db', () => ({
  applyBootstrap: (url: string, _passwords: unknown, at: unknown) => {
    applied.push(`bootstrap:${new URL(url).username}`);
    locations.push(at);
    return Promise.resolve();
  },
  applyMigrations: (url: string) => {
    applied.push(`migrations:${new URL(url).username}`);
    return Promise.resolve();
  },
  withRole: (url: string, role: string, password: string) => {
    const parsed = new URL(url);
    parsed.username = encodeURIComponent(role);
    parsed.password = encodeURIComponent(password);
    return parsed.toString();
  },
}));

const path = (name: string) => `/sommelier/dev/${name}`;

const ok = () => {
  state.invalid = [];
  state.parameters = [
    { Name: path('database/master_url'), Value: 'postgres://master:pw@db.example:5432/sommelier' },
    { Name: path('database/app_rw_password'), Value: 'rw-pw' },
    { Name: path('database/app_migrate_password'), Value: 'migrate-pw' },
  ];
};

beforeEach(() => {
  vi.stubEnv('SST_STAGE', 'dev');
  vi.stubEnv('SQL_ROOT', '/var/task/sql');
  sent.length = 0;
  applied.length = 0;
  locations.length = 0;
  ok();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const load = async () => (await import('../src/index.js')).handler;

describe('the migration runner', () => {
  it('applies bootstrap as master, then migrations as app_migrate', async () => {
    const handler = await load();
    const result = await handler();

    /*
     * The order and the roles are the point. Bootstrap needs privileges
     * `app_migrate` does not have and cannot grant itself; migrations must NOT
     * run as master, because whoever runs one owns the tables it creates and
     * `FORCE ROW LEVEL SECURITY` does not apply to a table's owner — every
     * P0-37 policy would be silently inert for the schema owner.
     */
    expect(applied).toEqual(['bootstrap:master', 'migrations:app_migrate']);
    expect(result).toMatchObject({ ok: true, stage: 'dev' });
  });

  it('names the paths a partial IAM grant could not read', async () => {
    state.invalid = [path('database/master_url')];

    const handler = await load();

    /*
     * The failure worth engineering for. `deployParameterReadPermissions()`
     * grants these three and the application grant refuses them outright, so
     * the realistic mistake is wiring the wrong one — and the symptom without
     * this check is `undefined` interpolated into a connection string, failing
     * later and elsewhere with a message about a host that does not exist.
     */
    await expect(handler()).rejects.toThrow(/database\/master_url/);
    await expect(handler()).rejects.toThrow(/P0-21a/);
    expect(applied).toEqual([]);
  });

  it('refuses a parameter that resolved empty', async () => {
    state.parameters = state.parameters.map((p) =>
      p.Name.endsWith('app_migrate_password') ? { ...p, Value: '' } : p,
    );

    // Fail closed: a blank secret reaching the caller reads as "not configured"
    // and gets treated as a default — the same reasoning as P0-15's loader.
    const handler = await load();
    await expect(handler()).rejects.toThrow(/resolved empty/);
    expect(applied).toEqual([]);
  });

  it('refuses to run with no stage', async () => {
    vi.stubEnv('SST_STAGE', '');

    // Without a stage the parameter paths address `/sommelier//…`, which
    // resolves to nothing — but the failure should say *why* rather than
    // arriving as three invalid parameters.
    const handler = await load();
    await expect(handler()).rejects.toThrow(/SST_STAGE/);
  });

  it('reads all three parameters in one call, decrypted', async () => {
    const handler = await load();
    await handler();

    const input = (sent[0] as { input: { Names: string[]; WithDecryption: boolean } }).input;

    // One round trip, and `InvalidParameters` is what makes the test above
    // possible — three separate GetParameter calls would each fail alone.
    expect(input.Names).toEqual([
      path('database/master_url'),
      path('database/app_rw_password'),
      path('database/app_migrate_password'),
    ]);
    expect(input.WithDecryption).toBe(true);
  });

  it('falls back to the packaged SQL location when SQL_ROOT is unset', async () => {
    // The infrastructure sets it, so the default is what runs if that line is
    // ever dropped — and the two must agree. `/var/task` is the Lambda root.
    vi.stubEnv('SQL_ROOT', '');
    const handler = await load();
    await handler();

    expect(locations[0]).toEqual({
      bootstrapDir: '/var/task/sql/bootstrap',
      migrationsDir: '/var/task/sql/migrations',
    });
  });

  it('treats an SSM response with no Parameters as everything missing', async () => {
    /*
     * The SDK omits empty arrays rather than returning them, so this is the
     * shape a denied read actually arrives in — not a hypothetical. Without the
     * fallbacks it would be a TypeError on `.map` of undefined, which says
     * nothing about which parameter was refused.
     */
    state.invalid = [];
    state.parameters = [];
    const handler = await load();

    await expect(handler()).rejects.toThrow(/resolved empty/);
    expect(applied).toEqual([]);
  });

  it('passes the copied SQL location rather than the package default', async () => {
    /*
     * The bundle collapses `packages/db` into one file, so `deploy.ts`'s
     * `import.meta.url`-relative default resolves to `/var/`. This is the
     * assertion that the handler overrides it — a silent fallback would mean a
     * runner that finds no migrations and reports success.
     */
    const handler = await load();
    await handler();

    expect(locations[0]).toEqual({
      bootstrapDir: '/var/task/sql/bootstrap',
      migrationsDir: '/var/task/sql/migrations',
    });
  });
});
