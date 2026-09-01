#!/usr/bin/env node
/**
 * Typechecks `sst.config.ts` and `infra/**` (P0-13).
 *
 * These files cannot join the normal `pnpm typecheck`: their types come from
 * `.sst/platform`, which `sst install` generates and git ignores, and they rely
 * on globals (`$config`, `$app`, `sst.aws.*`) that no package tsconfig knows
 * about. Before this existed, every line of infrastructure was unverified.
 *
 * Errors are filtered to our own files on purpose. SST's platform sources are
 * pulled into the program by its own declarations and currently do not compile
 * cleanly against the Node types resolved here — a mismatch inside a vendored
 * toolchain, which we cannot fix and must not be blocked by. Suppressing by
 * path is narrow and visible; `skipLibCheck` does not help because the offending
 * files are .ts sources rather than declarations.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { die } from './lib/report.mjs';

const ROOT = resolve(import.meta.dirname, '..');
/** Our own files, on either path separator — no regex, so no escaping to get wrong. */
const isOurs = (line) =>
  line.startsWith('sst.config.ts') || line.startsWith('infra/') || line.startsWith('infra' + sep);

if (!existsSync(join(ROOT, '.sst', 'platform', 'config.d.ts'))) {
  die(
    'SST platform types are missing, so infrastructure cannot be typechecked.',
    'Run `pnpm sst install` first. Skipping silently here would report a green\n' +
      'check for files nothing had verified.',
  );
}

/**
 * Invoke the compiler's JS entry point directly with node.
 *
 * Not via `npx`: on Windows that resolves to `npx.cmd`, and since the fix for
 * CVE-2024-27980 Node refuses to spawn `.cmd` without `shell: true`. It fails
 * with EINVAL, produces no output, and this gate then finds zero errors and
 * reports success — a check that passes precisely because it never ran.
 */
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(TSC)) die('cannot find the TypeScript compiler at ' + TSC);

const tsc = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.sst.json'], {
  cwd: ROOT,
  encoding: 'utf8',
});

// The guard the first version of this script lacked. `tsc` exits 0 with no
// output when clean and 2 with output when not; anything else means it did not
// run, and silence must never be read as success.
if (tsc.error) die('could not run the TypeScript compiler', tsc.error.message);
if (tsc.status === null) die('the TypeScript compiler was killed before finishing');
if (tsc.status !== 0 && !(tsc.stdout ?? '').trim()) {
  die('the compiler exited ' + tsc.status + ' without reporting anything', tsc.stderr);
}

const lines = (tsc.stdout ?? '').split('\n').filter((l) => l.trim().length > 0);
const ours = lines.filter((l) => isOurs(l));
const vendored = lines.filter((l) => l.startsWith('.sst/')).length;

if (ours.length) {
  console.error('\n  Infrastructure typecheck failed:\n');
  ours.forEach((l) => console.error('  ' + l));
  console.error('');
  process.exit(1);
}

console.log(
  '\n  Infrastructure typechecks clean (sst.config.ts, infra/**).' +
    (vendored ? '\n  ' + vendored + ' pre-existing error(s) inside .sst/platform ignored.' : '') +
    '\n',
);
