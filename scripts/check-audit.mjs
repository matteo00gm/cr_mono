#!/usr/bin/env node
/**
 * Dependency vulnerability gate (P0-08).
 *
 * Fails on high/critical advisories unless they are allowlisted in
 * `audit-allowlist.json` with a reason and an expiry date.
 *
 * Why a script rather than plain `pnpm audit --audit-level=high`: pnpm has no
 * notion of an accepted risk. Without one, the only ways past a finding you
 * have consciously decided to accept are lowering the threshold for everything
 * or deleting the step — both of which turn the gate off permanently in order
 * to get past one advisory.
 *
 * Usage: node scripts/check-audit.mjs [path/to/pnpm-audit.json]
 * The optional argument feeds the gate a fixture so its failure paths can be
 * tested without waiting for a real advisory to exist.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { die, table } from './lib/report.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ALLOWLIST_PATH = join(ROOT, 'audit-allowlist.json');

/** §P0-08: fail on high and critical. Lower severities are Renovate's job. */
const BLOCKING = new Set(['high', 'critical']);

/**
 * An expiry date alone does not stop an exception becoming permanent — nothing
 * prevents `2099-01-01`. The horizon cap is what actually forces the decision
 * to be revisited, so it is the load-bearing half of the rule.
 */
const MAX_HORIZON_DAYS = 90;

const ISO_DATE = new RegExp('^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
const DAY_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------- input
const readAudit = (argPath) => {
  if (argPath) {
    const p = resolve(argPath);
    if (!existsSync(p)) die('no audit fixture at ' + p);
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  // `pnpm audit` exits non-zero when it finds anything, which is not an error
  // here — the findings are the payload. Read stdout either way.
  try {
    return JSON.parse(execSync('pnpm audit --json', { cwd: ROOT, encoding: 'utf8' }));
  } catch (err) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        die('pnpm audit produced unparseable output', err.stdout.slice(0, 400));
      }
    }
    return die('could not run `pnpm audit --json`', err.message);
  }
};

const audit = readAudit(process.argv[2]);
const advisories = Object.values(audit.advisories ?? {});

// --------------------------------------------------- allowlist and its rules
const allowlist = existsSync(ALLOWLIST_PATH)
  ? JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
  : { entries: [] };

const entries = allowlist.entries ?? [];
const today = new Date(new Date().toISOString().slice(0, 10));
const problems = [];

entries.forEach((e, i) => {
  const at = 'audit-allowlist.json entries[' + i + ']';
  if (!e.id) problems.push(at + ': missing "id" (the GHSA or advisory id)');
  if (!e.package) problems.push(at + ': missing "package"');
  if (!e.reason || String(e.reason).trim().length < 20) {
    problems.push(at + ': "reason" must be a real explanation, not a placeholder');
  }
  if (!e.expires || !ISO_DATE.test(String(e.expires))) {
    problems.push(at + ': "expires" must be present and formatted YYYY-MM-DD');
    return;
  }
  const expires = new Date(e.expires);
  if (Number.isNaN(expires.getTime())) {
    problems.push(at + ': "expires" is not a real date');
    return;
  }
  const days = Math.round((expires - today) / DAY_MS);
  if (days < 0) {
    problems.push(
      at +
        ' (' +
        e.id +
        '): expired ' +
        -days +
        ' day(s) ago. Re-evaluate the ' +
        'risk and either fix it or set a new expiry with a fresh reason.',
    );
  } else if (days > MAX_HORIZON_DAYS) {
    problems.push(
      at +
        ' (' +
        e.id +
        '): expires in ' +
        days +
        ' days, beyond the ' +
        MAX_HORIZON_DAYS +
        '-day cap. A long horizon is a permanent exception ' +
        'with extra steps.',
    );
  }
});

if (problems.length) {
  die('the audit allowlist is not valid:', problems.join('\n'));
}

const allowed = new Set(entries.map((e) => String(e.id)));
const matchesEntry = (a) =>
  allowed.has(String(a.github_advisory_id ?? '')) || allowed.has(String(a.id ?? ''));

// ------------------------------------------------------------------ evaluate
const blocking = advisories.filter((a) => BLOCKING.has(String(a.severity).toLowerCase()));
const unexcused = blocking.filter((a) => !matchesEntry(a));
const excused = blocking.filter(matchesEntry);

const counts = audit.metadata?.vulnerabilities ?? {};
console.log('\n  Dependency audit\n');
console.log(
  '  scanned ' +
    (audit.metadata?.totalDependencies ?? '?') +
    ' dependencies — critical ' +
    (counts.critical ?? 0) +
    ', high ' +
    (counts.high ?? 0) +
    ', moderate ' +
    (counts.moderate ?? 0) +
    ', low ' +
    (counts.low ?? 0),
);

if (excused.length) {
  console.log('\n  Accepted (allowlisted, unexpired):');
  console.log(
    table(
      ['Advisory', 'Package', 'Severity', 'Expires'],
      excused.map((a) => {
        const e = entries.find((x) => String(x.id) === String(a.github_advisory_id ?? a.id));
        return [a.github_advisory_id ?? a.id, a.module_name, a.severity, e?.expires ?? '?'];
      }),
    ),
  );
}

// Stale entries are reported, not fatal: an advisory disappearing is good news,
// and failing CI for it would punish the fix. The horizon cap above is what
// keeps the file from silting up.
const stale = entries.filter(
  (e) => !blocking.some((a) => String(a.github_advisory_id ?? a.id) === String(e.id)),
);
if (stale.length) {
  console.log(
    '\n  note: ' +
      stale.length +
      ' allowlist entry/entries no longer match any ' +
      'high or critical advisory and can be deleted: ' +
      stale.map((e) => e.id).join(', '),
  );
}

if (unexcused.length) {
  console.error('\n  Blocking advisories with no accepted-risk entry:\n');
  console.error(
    table(
      ['Advisory', 'Package', 'Severity', 'Title'],
      unexcused.map((a) => [
        a.github_advisory_id ?? a.id,
        a.module_name,
        a.severity,
        String(a.title ?? '').slice(0, 52),
      ]),
    ),
  );
  console.error(
    '\n  Fix by upgrading, or record an accepted risk in audit-allowlist.json\n' +
      '  with a reason and an expiry no more than ' +
      MAX_HORIZON_DAYS +
      ' days out.\n',
  );
  process.exit(1);
}

console.log('\n  No blocking advisories.\n');
