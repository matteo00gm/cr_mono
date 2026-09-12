import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The lint half of P0-48, asserting itself.
 *
 * A lint rule that silently stops matching is indistinguishable from a clean
 * codebase — the same reasoning P0-08 applies to the secret scanner, and the
 * same fix: the rule proves it still fires on every run rather than at review
 * time only. It is also what the plan's "verify by adding an unprotected route
 * in a scratch commit" asks for, made permanent instead of done once.
 *
 * Both directions matter and neither is sufficient alone. A rule that catches
 * nothing looks like protection; a rule that catches *everything* — including
 * `membership.tenantId`, the resolved value handlers are supposed to use — gets
 * disabled, and a disabled rule protects nothing.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

/** Every directory this suite writes a fixture into, for the sweep below. */
const FIXTURE_DIRS = ['apps/api/src', 'apps/api/src/middleware', 'packages/core/src'];

// Each case shells the whole flat config through the type-aware parser, which
// is slow enough under coverage instrumentation to pass the 5s default.
const LINT_TIMEOUT_MS = 30_000;

/**
 * Fixtures are written to real paths, briefly.
 *
 * `lintText` with a synthetic path fails before any rule runs: the type-aware
 * parser's project service refuses a file it cannot find in a tsconfig. Since
 * the thing under test is the *repository's* configuration — including a
 * file-scoped exception — linting a real path is also the more honest check.
 *
 * **The directory is what the configuration keys on; the filename is not.**
 * `eslint.config.js` exempts `apps/api/src/middleware/tenant.ts` by exact path
 * and otherwise selects by directory, so the suffix below changes nothing about
 * which rules apply — which is what makes a unique name per call safe.
 */
let fixtureCounter = 0;

/**
 * A fresh filename for every lint, in the directory the caller asked for.
 *
 * Two reasons, and the second is the one that cost an afternoon.
 *
 * The type-aware project service caches a file by path. Writing different
 * sources to the *same* path in quick succession — which this suite does,
 * once per forbidden shape — invites it to lint content that is no longer
 * there, on a machine fast enough that the mtimes collide. This suite failed
 * once in a full run and never in isolation, which is the shape of exactly
 * that; a unique path removes the mechanism whether or not it was the cause.
 *
 * And a killed test process never reaches the `finally` below, so an
 * interrupted run leaves a fixture in `src/`, where `pnpm lint` then fails on
 * the `any` inside it for a reason nobody would trace back to a test. A
 * predictable suffix is what lets `.gitignore` and the sweep below match them
 * all rather than the one somebody remembered.
 */
const fixturePath = (relativePath: string): string => {
  fixtureCounter += 1;

  return relativePath.replace(/\.ts$/, `.${String(fixtureCounter)}.fixture.ts`);
};

/**
 * Removes fixtures an interrupted run left behind.
 *
 * Cheap, and it runs before anything else: a stray from a previous session
 * would otherwise sit in `src/` failing lint for everyone until somebody
 * noticed the filename was not one of ours.
 */
const sweepStrays = () => {
  for (const dir of FIXTURE_DIRS) {
    const absolute = join(ROOT, dir);
    if (!existsSync(absolute)) continue;

    for (const name of readdirSync(absolute)) {
      if (name.includes('.fixture.ts')) rmSync(join(absolute, name), { force: true });
    }
  }
};

const lintSource = async (source: string, relativePath: string) => {
  const scoped = fixturePath(relativePath);
  const absolute = join(ROOT, scoped);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, 'utf8');

  try {
    return await lintFile(scoped);
  } finally {
    rmSync(absolute, { force: true });
  }
};

/**
 * One instance for the whole file.
 *
 * Constructing an `ESLint` loads the flat config and starts the type-aware
 * project service, which dominates the cost — building one per assertion took
 * this suite past the default timeout as soon as it ran under coverage
 * instrumentation.
 */
const eslint = new ESLint({ cwd: process.cwd() });

// Before anything, and after everything: a stray from an interrupted run is a
// lint failure nobody would trace back to a test suite.
beforeAll(sweepStrays);
afterAll(sweepStrays);

const lintFile = async (relativePath: string) => {
  const [result] = await eslint.lintFiles([join(ROOT, relativePath)]);
  const messages = result?.messages ?? [];

  // A parse failure would otherwise read as "no violations found", which is the
  // way this whole suite could pass while testing nothing.
  const fatal = messages.filter((message) => message.fatal);
  if (fatal.length > 0) throw new Error(`fixture failed to parse: ${fatal[0]?.message ?? ''}`);

  return messages.filter((message) => message.ruleId === 'no-restricted-syntax');
};

const HANDLER = 'apps/api/src/handler.ts';

describe('shapes the rule must reject', () => {
  const forbidden: readonly [string, string][] = [
    ['a header read by literal name', `export const f = (c: any) => c.req.header('x-tenant-id');`],
    ['a query parameter', `export const f = (c: any) => c.req.query('tenantId');`],
    ['a path parameter', `export const f = (c: any) => c.req.param('tenantId');`],
    ['a validated body', `export const f = (c: any) => c.req.valid('json').tenantId;`],
    ['a parsed body', `export const f = async (c: any) => (await c.req.json()).tenantId;`],
    ['a destructured payload', `export const f = (body: any) => body.tenantId;`],
    [
      'a header read through a named constant',
      `const TENANT_HEADER = 'x-tenant-id';\n` +
        `export const f = (c: any) => c.req.header(TENANT_HEADER);`,
    ],
  ];

  it.each(forbidden)('rejects %s', { timeout: LINT_TIMEOUT_MS }, async (_label, source) => {
    /*
     * The last case is the one worth having. Without it the rule is sidestepped
     * by hoisting the string into a `const`, and the file-level exception below
     * would be decorative rather than load-bearing.
     */
    expect(await lintSource(source, HANDLER)).not.toHaveLength(0);
  });
});

describe('shapes the rule must allow', () => {
  const allowed: readonly [string, string][] = [
    ['the resolved tenant from the context', `export const f = (c: any) => c.get('tenantId');`],
    [
      'a tenant id on a membership row',
      `export const f = (m: { tenantId: string }) => m.tenantId;`,
    ],
    [
      'a tenant id on the request-scoped log context',
      `export const f = (ctx: { tenantId?: string }) => ctx.tenantId;`,
    ],
    ['an unrelated header', `export const f = (c: any) => c.req.header('x-amzn-trace-id');`],
  ];

  it.each(allowed)('allows %s', { timeout: LINT_TIMEOUT_MS }, async (_label, source) => {
    expect(await lintSource(source, HANDLER)).toHaveLength(0);
  });
});

describe('the single exception', () => {
  it(
    'covers the real tenant middleware as it stands today',
    { timeout: LINT_TIMEOUT_MS },
    async () => {
      /*
       * Linted as it actually is, not as a fixture. `resolveTenant` reads the
       * active-tenant header because a user may belong to several wineries and
       * something has to choose — what it reads is a selection among rows the
       * database already agrees exist, re-validated on every request.
       */
      expect(await lintFile('apps/api/src/middleware/tenant.ts')).toHaveLength(0);
    },
  );

  it(
    'is one file, and does not extend to its neighbours',
    { timeout: LINT_TIMEOUT_MS },
    async () => {
      // Named as a file rather than a directory pattern, so a second middleware
      // cannot inherit the exception by sitting beside the first.
      const source =
        `const ACTIVE_TENANT_HEADER = 'x-active-tenant';\n` +
        `export const f = (c: any) => c.req.header(ACTIVE_TENANT_HEADER);`;

      expect(await lintSource(source, 'apps/api/src/middleware/neighbour.ts')).not.toHaveLength(0);
    },
  );
});

describe('what the rule cannot catch', () => {
  it(
    'does not see through a constant named to hide the intent',
    { timeout: LINT_TIMEOUT_MS },
    async () => {
      /*
       * Stated rather than papered over. The rule matches the *name* of a
       * constant passed to `header()`, so `const H = 'x-tenant-id'` slips past
       * it. That is a deliberate limit rather than a flaw: a selector matching
       * every `header()` call would flag `x-amzn-trace-id` and be turned off
       * within a week.
       *
       * It is also why the rule is only half of P0-48. The behavioural test
       * asserts the *effective* tenant on returned data, so a handler that got a
       * tenant id in by any means at all still fails — the rule catches the next
       * author, the test catches the code.
       */
      const source = `const H = 'x-tenant-id';
export const f = (c: any) => c.req.header(H);`;

      expect(await lintSource(source, HANDLER)).toHaveLength(0);
    },
  );
});

describe('scope', () => {
  it('does not apply outside apps/api', { timeout: LINT_TIMEOUT_MS }, async () => {
    /*
     * `packages/core` has no request to read a tenant from — `resolveMembership`
     * takes a plain argument — so the rule has nothing to say there, and saying
     * it anyway would flag the parameter carrying the *validated* selection.
     */
    const source = `export const f = (i: { requestedTenantId?: string }) => i.requestedTenantId;`;

    expect(await lintSource(source, 'packages/core/src/scratch.ts')).toHaveLength(0);
  });
});
