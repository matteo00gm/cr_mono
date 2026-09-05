#!/usr/bin/env node
/**
 * Structural checks on the ADR set (P0-59).
 *
 * An ADR system decays in three specific ways, and none of them is visible by
 * reading any single file — which is why this is a script and not a review
 * habit:
 *
 * 1. **A decision arrives without its status or date**, so nobody can tell
 *    whether it still holds.
 * 2. **Numbering drifts** — a gap looks like a deleted decision, and a
 *    duplicate means one of the two is unreachable by its own id.
 * 3. **A supersession points at nothing.** `Superseded by 0021` with no 0021
 *    is worse than no marker at all: it says the decision changed and then
 *    refuses to say how.
 *
 * The append-only rule itself cannot be checked here — that is what code review
 * and git history are for — but every consequence of breaking it can be.
 *
 * Usage: node scripts/check-adrs.mjs [dir]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { die as reportDie, table } from './lib/report.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIR = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'docs', 'adr');

const die = (msg) => reportDie('ADR check failed: ' + msg);

/** `NNNN-slug.md`, four digits, lowercase kebab. The template is exempt. */
const NAME = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** Sections every ADR must carry, in the order the template sets. */
const SECTIONS = ['## Context', '## Decision', '## Consequences', '## Alternatives rejected'];

const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.md') && name !== 'README.md')
  .sort();

if (files.length === 0) die('no ADRs found in ' + DIR);

const problems = [];
const rows = [];
const byNumber = new Map();

for (const file of files) {
  const path = join(DIR, file);
  const body = readFileSync(path, 'utf8');
  const complain = (msg) => problems.push(`${file}: ${msg}`);

  // 0000 is the template. It must exist and must carry the same shape as a
  // real ADR — a template that has drifted from what is checked teaches the
  // wrong format to whoever copies it.
  const match = NAME.exec(file);
  if (!match) {
    complain('name must be NNNN-kebab-slug.md');
    continue;
  }

  const number = Number(match[1]);
  if (byNumber.has(number)) complain(`duplicate number, also used by ${byNumber.get(number)}`);
  byNumber.set(number, file);

  const status = /^Status:\s*(.+)$/m.exec(body)?.[1]?.trim();
  const date = /^Date:\s*(.+)$/m.exec(body)?.[1]?.trim();

  // The template must carry both fields, so whoever copies it learns the shape
  // — but its placeholders are not expected to satisfy the format rules.
  if (!status) complain('missing `Status:`');
  if (!date) complain('missing `Date:`');

  if (number !== 0) {
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      complain(`Date must be ISO (YYYY-MM-DD), got "${date}"`);
    }
    // `Accepted`, `Superseded by NNNN`, or `Proposed` while under discussion.
    if (status && !/^(Accepted|Proposed|Superseded by \d{4})$/.test(status)) {
      complain(`Status must be Accepted, Proposed or "Superseded by NNNN", got "${status}"`);
    }
    for (const section of SECTIONS) {
      if (!body.includes(section)) complain(`missing section ${section}`);
    }
  }

  rows.push([file, status ?? '-', date ?? '-']);
}

// ---------------------------------------------------------------- numbering
const numbers = [...byNumber.keys()].sort((a, b) => a - b);
if (numbers[0] !== 0) problems.push('there is no 0000-template.md');

for (let i = 1; i < numbers.length; i += 1) {
  const gap = numbers[i] - numbers[i - 1];
  if (gap > 1) {
    /*
     * A gap is not a style problem. ADRs are append-only and numbered
     * sequentially, so a missing number means a decision was deleted — and the
     * whole point of the system is that decisions are never deleted, only
     * superseded.
     */
    problems.push(
      `numbering gap between ${String(numbers[i - 1]).padStart(4, '0')} and ` +
        `${String(numbers[i]).padStart(4, '0')} — ADRs are append-only, so a gap means one was removed`,
    );
  }
}

// ------------------------------------------------------------- supersession
for (const file of files) {
  const body = readFileSync(join(DIR, file), 'utf8');
  const refs = [
    ...[...body.matchAll(/^Status:\s*Superseded by (\d{4})$/gm)].map((m) => [
      'Superseded by',
      m[1],
    ]),
    ...[...body.matchAll(/^Supersedes:\s*(\d{4})$/gm)].map((m) => ['Supersedes', m[1]]),
  ];

  for (const [kind, ref] of refs) {
    if (!byNumber.has(Number(ref))) {
      problems.push(`${file}: ${kind} ${ref}, which does not exist`);
      continue;
    }

    /*
     * Both directions or neither. A one-sided supersession leaves whichever
     * file the reader opened first looking current, which is the failure the
     * marker exists to prevent.
     */
    const other = readFileSync(join(DIR, byNumber.get(Number(ref))), 'utf8');
    const self = /^(\d{4})/.exec(file)[1];
    const expected =
      kind === 'Supersedes' ? `Status: Superseded by ${self}` : `Supersedes: ${self}`;
    if (!other.includes(expected)) {
      problems.push(
        `${file}: ${kind} ${ref}, but ${byNumber.get(Number(ref))} does not carry "${expected}"`,
      );
    }
  }
}

console.log('\n  ADRs (P0-59)\n');
console.log(table(['File', 'Status', 'Date'], rows));

if (problems.length > 0) {
  die('\n    ' + problems.join('\n    '));
}
console.log(`\n  ${String(rows.length)} ADRs, numbering contiguous, references resolve.\n`);
