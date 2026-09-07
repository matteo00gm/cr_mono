#!/usr/bin/env node
/**
 * Structural checks on the AGENTS.md set (P0-60).
 *
 * The same reflection pattern as P0-41's "every tenant table has RLS": packages
 * are discovered on disk rather than listed here, so **a new package cannot
 * skip its invariants** — it fails this check the moment it exists, which is
 * the intended prompt.
 *
 * Two other things are checked, both about the invariants themselves:
 *
 * 1. **Every invariant cites a task id.** An unattributed prohibition is one
 *    nobody can look up, so it gets followed until it is inconvenient and then
 *    quietly dropped. The citation is what makes it arguable rather than
 *    arbitrary.
 * 2. **The root file stays short.** Long files get skimmed by humans and
 *    truncated by models alike, and a rule nobody read is a rule that is not in
 *    force. The row sets ~200 lines.
 *
 * Usage: node scripts/check-agents-md.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { die as reportDie, table } from './lib/report.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const NAME = 'AGENTS.md';

/**
 * The root file's budget.
 *
 * Not arbitrary: the point of these files is that they are read in full before
 * a change, and a file that is skimmed has the same effect as no file.
 */
const ROOT_MAX_LINES = 200;

/**
 * A task id: `P0-19`, `P2-08`, `P0-17a`, `P4-03a`. Section references like
 * `§3.7` are allowed alongside one but do not satisfy the requirement on their
 * own — a section says where a rule came from, a task id says who to ask.
 */
const TASK_ID = /\(P\d-\d{2}[a-z]?(?:,\s*P\d-\d{2}[a-z]?)*\)|\bP\d-\d{2}[a-z]?\b/;

const die = (msg) => reportDie('AGENTS.md check failed: ' + msg);

const packages = ['apps', 'packages'].flatMap((group) => {
  const dir = join(ROOT, group);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'package.json')))
    .map((entry) => `${group}/${entry.name}`);
});

const problems = [];
const rows = [];

/** Bullet lines under an `## Invariants` heading, until the next heading. */
const invariantsOf = (body) => {
  const start = body.indexOf('## Invariants');
  if (start === -1) return undefined;

  const rest = body.slice(start + '## Invariants'.length);
  const end = rest.indexOf('\n## ');
  const section = end === -1 ? rest : rest.slice(0, end);

  /*
   * Continuation lines are joined back onto their bullet before the citation
   * is looked for. An invariant wrapped across three lines carries its task id
   * on the last one, and checking line-by-line would reject every wrapped rule
   * — which is most of them.
   */
  const bullets = [];
  for (const line of section.split('\n')) {
    if (line.startsWith('- ')) bullets.push(line);
    else if (bullets.length > 0 && line.trim() !== '' && line.startsWith('  ')) {
      bullets[bullets.length - 1] += ' ' + line.trim();
    } else if (line.trim() === '') {
      // A blank line ends a bullet but not the section.
    }
  }
  return bullets;
};

const check = (label, path, { isRoot = false } = {}) => {
  if (!existsSync(path)) {
    problems.push(`${label}: no ${NAME} — every package needs one (P0-60)`);
    rows.push([label, '-', '-', 'MISSING']);
    return;
  }

  const body = readFileSync(path, 'utf8');
  const lines = body.split('\n').length;
  const bullets = invariantsOf(body);

  if (bullets === undefined) {
    problems.push(`${label}: no "## Invariants" section`);
    rows.push([label, String(lines), '-', 'FAIL']);
    return;
  }

  if (bullets.length === 0) {
    problems.push(`${label}: "## Invariants" is empty`);
  }

  const uncited = bullets.filter((bullet) => !TASK_ID.test(bullet));
  for (const bullet of uncited) {
    const preview = bullet.slice(2, 72).replace(/\s+/g, ' ');
    problems.push(`${label}: invariant cites no task id — "${preview}…"`);
  }

  if (isRoot && lines > ROOT_MAX_LINES) {
    problems.push(
      `${label}: ${String(lines)} lines, over the ${String(ROOT_MAX_LINES)}-line budget — ` +
        'long files get skimmed by humans and truncated by models, and a rule nobody read is not in force',
    );
  }

  rows.push([label, String(lines), String(bullets.length), uncited.length === 0 ? 'ok' : 'FAIL']);
};

check(NAME, join(ROOT, NAME), { isRoot: true });
for (const pkg of packages) check(`${pkg}/${NAME}`, join(ROOT, pkg, NAME));

// `CLAUDE.md` is what some tools look for. It must not be a second copy that
// drifts — a symlink where the platform allows one, and otherwise identical.
const claude = join(ROOT, 'CLAUDE.md');
if (!existsSync(claude)) {
  problems.push('CLAUDE.md is missing — tools that look for that name find nothing');
} else if (readFileSync(claude, 'utf8').trim() !== readFileSync(join(ROOT, NAME), 'utf8').trim()) {
  problems.push('CLAUDE.md has drifted from AGENTS.md — they must be identical');
}

console.log('\n  AGENTS.md (P0-60)\n');
console.log(table(['File', 'Lines', 'Invariants', ''], rows));

if (problems.length > 0) die('\n    ' + problems.join('\n    '));
console.log(
  `\n  ${String(rows.length)} files, every invariant cites a task id, CLAUDE.md matches.\n`,
);
