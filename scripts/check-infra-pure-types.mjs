#!/usr/bin/env node
/**
 * Typechecks the parts of `infra/` that do not need SST (P1-32a).
 *
 * **`typecheck:infra` cannot run in CI, and that let a type error ship.**
 * Everything under `infra/` is excluded from every package tsconfig, because
 * most of it depends on globals (`$app`, `sst.aws.*`) declared by
 * `.sst/platform/config.d.ts` — a 340 MB tree that `sst install` generates and
 * git ignores. So the only gate on those files is a local script, and a local
 * script is one somebody forgets: `ConnectionBudget` shipped in #106 typed as
 * `typeof CONNECTIONS`, which made the value its own test needed a type error,
 * and no CI job looked.
 *
 * Not all of `infra/` needs those globals. `queue-config.ts`, `static-assets.ts`
 * and `stage.ts` are ordinary modules over node built-ins — and every test under
 * `infra/test/` is a test *of* those, because the SST-dependent files cannot be
 * imported outside a deploy at all. Those files can be typechecked anywhere, and
 * this is what does it.
 *
 * **The split is derived, never listed.** A file that needs the SST globals
 * says so in its first lines with a `/// <reference path=... .sst/platform ...>`
 * directive — it has to, or the compiler cannot resolve them. Reading that is
 * what keeps a new pure module covered the day it is written, instead of the
 * day somebody remembers to add it to an array.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { die, table } from './lib/report.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const INFRA = join(ROOT, 'infra');

/** Every `.ts` under `infra/`, one level of subdirectory included. */
const infraFiles = () => {
  const found = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) found.push(path);
    }
  };

  walk(INFRA);
  return found.sort();
};

/**
 * The directive that says "this file needs SST's globals".
 *
 * Matched on the path rather than the word `reference`, so an ordinary triple-
 * slash directive for something else does not exclude a file by accident.
 */
const NEEDS_SST = /\/\/\/\s*<reference\s+path=["'][^"']*\.sst\/platform/;

/**
 * Code shapes, not words.
 *
 * A file can only be excluded from this gate by declaring it needs SST — so the
 * way to dodge a type error would be to add the directive to a file that does
 * not need it. This is what makes that visible: an excluded file has to
 * actually construct something from the SST or Pulumi namespaces.
 */
const USES_SST = /\bnew sst\.|\bnew aws\.|\$app\b|\$interpolate`|\$util\.|\$jsonStringify\(/;

const files = infraFiles();
const sstFiles = [];
const pureFiles = [];

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  (NEEDS_SST.test(source) ? sstFiles : pureFiles).push({ file, source });
}

const dishonest = sstFiles.filter(({ source }) => !USES_SST.test(source));

if (dishonest.length > 0) {
  die(
    'these files declare they need SST but never use it:\n' +
      dishonest.map(({ file }) => '    ' + relative(ROOT, file)).join('\n') +
      '\n\n  The reference directive is what excludes a file from this gate, so a file\n' +
      '  carrying it without needing it is one nobody typechecks in CI. Remove the\n' +
      '  directive, or use the globals it claims.',
  );
}

if (pureFiles.length === 0) {
  die(
    'no infra file is typecheckable without SST, which cannot be right.\n' +
      '  Either every file grew a reference directive, or the detection above is\n' +
      '  broken — and a gate that checks nothing reports success.',
  );
}

/*
 * A temporary tsconfig rather than a committed one, because the file list is
 * derived. A committed config would be a second copy of the split, and the two
 * would disagree the first time somebody added a module.
 *
 * Written at the repository root rather than in the OS temp directory, which
 * was the first attempt and did not work: TypeScript resolves `node_modules`
 * upward from the config's own location, so a config in `%TEMP%` finds neither
 * `@types/node` nor `vitest` and reports errors about the toolchain instead of
 * about the code.
 */
const configPath = join(ROOT, '.tsconfig.infra-pure.json');

writeFileSync(
  configPath,
  JSON.stringify(
    {
      compilerOptions: {
        // Matches tsconfig.base.json, which these files would inherit if they
        // belonged to a package. Divergence here would mean CI accepting code
        // the rest of the repository rejects.
        module: 'esnext',
        moduleResolution: 'bundler',
        target: 'ES2023',
        lib: ['ES2023'],
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        isolatedModules: true,
        skipLibCheck: true,
        types: ['node'],
      },
      files: pureFiles.map(({ file }) => file),
    },
    null,
    2,
  ),
);

const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/*
 * `node tsc` rather than `npx`, for the reason `check-infra-types.mjs` gives at
 * length: on Windows `npx` resolves to `npx.cmd`, Node refuses to spawn `.cmd`
 * without a shell since CVE-2024-27980, and the failure is silent — the gate
 * finds zero errors because it never ran.
 */
const tsc = spawnSync(process.execPath, [TSC, '-p', configPath], {
  cwd: ROOT,
  encoding: 'utf8',
});

rmSync(configPath, { force: true });

if (tsc.error) die('could not run the TypeScript compiler', tsc.error.message);
if (tsc.status === null) die('the TypeScript compiler was killed before finishing');
if (tsc.status !== 0 && !(tsc.stdout ?? '').trim()) {
  die('the compiler exited ' + String(tsc.status) + ' without reporting anything', tsc.stderr);
}

const errors = (tsc.stdout ?? '').split('\n').filter((line) => line.trim().length > 0);

if (errors.length > 0) {
  die('infrastructure modules that need no SST do not typecheck:\n\n' + errors.join('\n'));
}

console.log(
  '\n  Infra type gate (P1-32a)\n\n' +
    table(
      ['File', 'Checked by'],
      [
        ...pureFiles.map(({ file }) => [relative(ROOT, file), 'this gate (CI)']),
        ...sstFiles.map(({ file }) => [relative(ROOT, file), 'typecheck:infra (local)']),
      ],
    ) +
    '\n\n  ' +
    String(pureFiles.length) +
    ' module(s) typecheck clean here; ' +
    String(sstFiles.length) +
    " need SST's globals.\n",
);
