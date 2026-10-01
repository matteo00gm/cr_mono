import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { describeThreat, REPO } from './manifest.js';

/**
 * T6 — Get free premium tier (§3.0, P4-17).
 *
 * A tenant's status and plan are never taken from a request, and nothing but a
 * verified billing event — or the first verified domain, which starts the
 * card-free trial — may ever change them. The signed webhook and its
 * idempotency are P5-03 and P5-04, and the transitions end to end through it
 * are P5-06's `stripe-webhooks.integration.test.ts`; the matrix names each.
 *
 * This file holds the other half: **production code writes `tenants.status`
 * and `tenants.plan` in one file only.** P5-05's statements are there, and a
 * second writer anywhere else fails here.
 */
describeThreat('T6');

/**
 * The files allowed to set a tenant's status or plan.
 *
 * `packages/db/src/billing.ts`, since P5-05: `writeBillingChange`, which only
 * the state machine's effect calls, on a claimed and verified event's
 * transaction; and `startTrial`, which moves `PENDING_VERIFICATION` to
 * `TRIALING` and nothing else, on the transaction that verifies a domain.
 */
const ALLOWED_WRITERS: readonly string[] = ['packages/db/src/billing.ts'];

/**
 * The shapes a write to either column takes: raw SQL, in an `UPDATE` or an
 * `INSERT`, and Drizzle's builder. Each is bounded by the template it sits in,
 * so a statement about another table nearby cannot be mistaken for one.
 */
const WRITES: readonly RegExp[] = [
  /\bUPDATE\s+tenants\b[^;`]*?\bSET\b[^;`]*?\b(?:status|plan)\s*=/iu,
  /\bINSERT\s+INTO\s+tenants\s*\([^)`]*\b(?:status|plan)\b/iu,
  /\.update\(\s*tenants\s*\)[\s\S]{0,200}?\.set\(\s*\{[^}]*\b(?:status|plan)\s*:/u,
];

/** Production source: every `src` under `apps/` and `packages/`, bar the test-only harness. */
const productionSources = (): string[] => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);

      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules' && name !== 'dist') walk(path);
      } else if (/\.tsx?$/u.test(name)) {
        files.push(path);
      }
    }
  };

  for (const area of ['apps', 'packages']) {
    for (const unit of readdirSync(join(REPO, area))) {
      /* Never imported by production code (CLAUDE.md), and it seeds any status it likes. */
      if (area === 'packages' && unit === 'testing') continue;

      const src = join(REPO, area, unit, 'src');
      try {
        if (statSync(src).isDirectory()) walk(src);
      } catch {
        /* An app with no src (the e2e harness) has nothing to scan. */
      }
    }
  }

  return files;
};

describe('a tenant’s status and plan', () => {
  it('are written by no production code outside the named writers', () => {
    const offenders = productionSources()
      .map((file) => relative(REPO, file).replaceAll('\\', '/'))
      .filter((file) => !ALLOWED_WRITERS.includes(file))
      .filter((file) => {
        const source = readFileSync(join(REPO, file), 'utf8');

        return WRITES.some((write) => write.test(source));
      });

    expect(offenders).toEqual([]);
  });

  it.each([
    "UPDATE tenants SET plan = 'ECOMMERCE' WHERE id = $1",
    'UPDATE tenants\n  SET status = ${next}, updated_at = now()',
    'INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, $4)',
    'db.update(tenants).set({ plan: body.plan })',
  ])('would notice a write shaped like: %s', (write) => {
    /* A guard that cannot fail is not a guard: each shape is caught. */
    expect(WRITES.some((pattern) => pattern.test(write))).toBe(true);
  });

  it.each([
    'UPDATE tenants SET turnstile_enabled = $1',
    "UPDATE domain_claims SET status = 'CANCELED'",
    'SELECT status, plan FROM tenants',
    'UPDATE tenants SET dev_origin = NULL, dev_mode_expires_at = NULL',
  ])('does not mistake this for one: %s', (statement) => {
    expect(WRITES.some((pattern) => pattern.test(statement))).toBe(false);
  });
});
