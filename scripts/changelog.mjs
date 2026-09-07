#!/usr/bin/env node
/**
 * Generates a changelog from commit subjects (P0-61).
 *
 * **Grouped by task id, not by `feat`/`fix`/`chore`.** That follows from the
 * commit convention this repository actually uses, and it is the more useful
 * grouping here: `P0-45` points at a specification that says what the change was
 * *for*, where `feat` says only that it was one. Commits with no task id — CI
 * wiring, plan sweeps, dependency bumps — are grouped under their area instead.
 *
 * **Not wired to a release, because there is no release.** Every package is
 * `private: true` at version `0.0.0` and nothing is published, so there is no
 * version to cut and nothing to attach this to. It is written and tested now so
 * that it works on the day there is — the alternative is writing it under time
 * pressure at the first release, which is when it gets skipped.
 *
 * Usage:
 *   node scripts/changelog.mjs [--from <ref>] [--to <ref>]
 *   node scripts/changelog.mjs --stdin   # read subjects, one per line
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

/** `P0-45: subject` or `CI: subject`. Merges and anything else are dropped. */
const SUBJECT = /^(P\d-\d{2}[a-z]?|[A-Z][A-Za-z]{1,14}(?: [A-Za-z]{2,14})?): (.+)$/;

const readSubjects = () => {
  if (args.includes('--stdin')) {
    // fd 0, so `git log --format=%s | node scripts/changelog.mjs --stdin` works.
    return process.stdin.isTTY ? [] : readFileSync(0, 'utf8').split('\n');
  }

  const range = flag('--from') ? `${flag('--from')}..${flag('--to') ?? 'HEAD'}` : 'HEAD';
  return execFileSync('git', ['log', '--format=%s', '--no-merges', range], {
    encoding: 'utf8',
  }).split('\n');
};

export const changelog = (subjects) => {
  const groups = new Map();

  for (const line of subjects) {
    const match = SUBJECT.exec(line.trim());
    if (!match) continue;

    const [, scope, subject] = match;
    if (!groups.has(scope)) groups.set(scope, []);
    groups.get(scope).push(subject);
  }

  /*
   * Task ids first and in order, then areas alphabetically. A reader scanning a
   * release wants the backlog rows; the CI and dependency noise belongs after
   * them, not interleaved by whatever order git happened to return.
   */
  const isTask = (scope) => /^P\d-/.test(scope);
  const scopes = [...groups.keys()].sort((a, b) => {
    if (isTask(a) !== isTask(b)) return isTask(a) ? -1 : 1;
    return a.localeCompare(b);
  });

  return scopes
    .map(
      (scope) =>
        `### ${scope}\n\n${groups
          .get(scope)
          .map((s) => `- ${s}`)
          .join('\n')}`,
    )
    .join('\n\n');
};

if (import.meta.filename === process.argv[1]) {
  const body = changelog(readSubjects());
  console.log(body === '' ? '_No changes with a recognised subject._' : body);
}
