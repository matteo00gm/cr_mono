import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DASHBOARD_PREFIX } from '../src/routes.js';
import { DASHBOARD_ROUTES } from '../src/surfaces/dashboard.js';
import { WIDGET_ROUTES } from '../src/surfaces/widget.js';

/**
 * The route tables, held to the API they describe (review, R8).
 *
 * `scripts/gen-openapi.mjs` refuses to publish an example that does not match
 * its schema; this says the same in the unit suite, next to the code, where a
 * failing example is found before anybody regenerates the reference. And the
 * success status is read off the handlers themselves, so a route that starts
 * answering 201 cannot keep a reference that says 200.
 */

describe('every example', () => {
  it.each([...DASHBOARD_ROUTES, ...WIDGET_ROUTES])('%s parses with its own schema', (_key, doc) => {
    const parsed = doc.response.safeParse(doc.example);

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

describe('the success status', () => {
  /**
   * Every dashboard handler that answers something other than 200, found in the
   * surface's source: a registration, then the first `c.json(…, 20x)` before
   * the next one. Crude, and deliberately so — it only has to find what a
   * reference would get wrong, and it fails loudly if it finds nothing at all.
   */
  const answeredBySource = (): Map<string, number> => {
    const source = readFileSync(join(import.meta.dirname, '../src/surfaces/dashboard.ts'), 'utf8');
    const registration = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/gu;
    const found = new Map<string, number>();
    const starts = [...source.matchAll(registration)];

    starts.forEach((match, index) => {
      const end = starts[index + 1]?.index ?? source.length;
      const handler = source.slice(match.index, end);
      /* A trailing comma is allowed: prettier puts a long call's status on a line of its own. */
      const status = /c\.json\([\s\S]*?,\s*(20[1-9])\s*,?\s*\)/u.exec(handler)?.[1];

      if (status !== undefined) {
        found.set(
          `${(match[1] ?? '').toUpperCase()} ${DASHBOARD_PREFIX}${match[2] ?? ''}`,
          Number(status),
        );
      }
    });

    return found;
  };

  it('is found in the handlers at all, so this cannot pass on nothing', () => {
    expect(answeredBySource().size).toBeGreaterThanOrEqual(5);
  });

  it('is declared on every route whose handler answers something other than 200', () => {
    for (const [key, status] of answeredBySource()) {
      expect(DASHBOARD_ROUTES.get(key)?.status, key).toBe(status);
    }
  });

  it('is not declared on a route whose handler answers 200', () => {
    const answered = answeredBySource();

    for (const [key, doc] of DASHBOARD_ROUTES) {
      if (doc.status !== undefined) expect(answered.get(key), key).toBe(doc.status);
    }
  });
});
