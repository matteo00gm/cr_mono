#!/usr/bin/env node
/**
 * Fails when a pull request does not say why (P0-61).
 *
 * `git log` answers *what* changed forever. Only the pull request body answers
 * *why*, and only if it is written while the author still remembers — asked six
 * months later, nobody reconstructs it accurately.
 *
 * **A template nobody fills is worse than no template**, because it manufactures
 * the appearance of process: the headings are all there, and the reviewer skims
 * past them assuming somebody wrote something. So the check is not "does the
 * heading exist" but "is there prose under it that the author actually typed".
 *
 * Reads the body from `$BODY`, which the workflow populates from
 * `github.event.pull_request.body`. Passed by environment rather than
 * interpolated into a shell command on purpose: a PR body is attacker-supplied
 * text, and `run: echo "${{ github.event.pull_request.body }}"` is a script
 * injection with a well-known shape.
 *
 * Usage: BODY="$(cat body.md)" node scripts/check-pr-why.mjs
 */
import process from 'node:process';
import { die as reportDie } from './lib/report.mjs';

const die = (msg) => reportDie('PR check failed: ' + msg);

const body = process.env.BODY ?? '';

if (body.trim() === '') {
  die('the pull request has an empty body — it needs a `## Why` section (P0-61)');
}

const heading = /^##\s+Why\s*$/im;
if (!heading.test(body)) {
  die('no `## Why` heading found. Use the pull request template.');
}

/** Everything between `## Why` and the next `## `, or the end. */
const after = body.slice(body.search(heading)).replace(heading, '');
const next = after.search(/^##\s+/m);
const section = (next === -1 ? after : after.slice(0, next))
  // HTML comments are the template's own guidance. Text that is still inside
  // one has not been written by the author.
  .replace(/<!--[\s\S]*?-->/g, '')
  .trim();

if (section === '') {
  die(
    'the `## Why` section is empty, or still holds only the template comment.\n\n' +
      '  What forced this change? What breaks without it? Written now it takes a\n' +
      '  minute; asked in six months it cannot be reconstructed accurately, which\n' +
      '  is the whole reason this is a gate rather than a suggestion.',
  );
}

/*
 * A length floor, deliberately low.
 *
 * The failure this catches is "." or "see title" — text typed to get past the
 * gate rather than to explain anything. It is not an attempt to measure quality,
 * which a script cannot do and should not pretend to.
 */
const MINIMUM = 40;
if (section.length < MINIMUM) {
  die(
    `the \`## Why\` section is ${String(section.length)} characters, under ${String(MINIMUM)}.\n\n` +
      '  That is short enough to be text typed to get past this check. Say what\n' +
      '  forced the change; a reviewer reads this before the diff.',
  );
}

console.log(`\n  PR explains why (${String(section.length)} characters).\n`);
