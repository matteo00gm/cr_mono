import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO, THREATS } from './manifest.js';

/**
 * The matrix itself (P4-17): ten threats, each with its named file, and the
 * words the plan uses for them.
 *
 * **The plan's §3.0 table is the source of the goals and controls**, and this
 * compares them word for word. A threat reworded in the plan and not here, or
 * the other way round, would leave the coverage document describing a model
 * nobody holds.
 */

/** The §3.0 rows, read from the plan: `| T1 | goal | control | test |`. */
const planRows = (): Map<string, { goal: string; control: string }> => {
  const plan = readFileSync(join(REPO, 'plan-v1.md'), 'utf8');
  const start = plan.indexOf('### 3.0 Threat model');
  const table = plan.slice(start, plan.indexOf('\n### ', start + 1));
  const rows = new Map<string, { goal: string; control: string }>();

  for (const line of table.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());

    if (/^T\d+$/u.test(cells[1] ?? '')) {
      rows.set(cells[1] ?? '', { goal: cells[2] ?? '', control: cells[3] ?? '' });
    }
  }

  return rows;
};

describe('the threat matrix', () => {
  it('is T1 to T10, in order, and nothing else', () => {
    expect(THREATS.map((threat) => threat.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `T${String(index + 1)}`),
    );
  });

  it('says what the plan says, word for word', () => {
    const rows = planRows();

    expect(rows.size).toBe(10);

    for (const threat of THREATS) {
      expect({ goal: threat.goal, control: threat.control }, threat.id).toEqual(
        rows.get(threat.id),
      );
    }
  });

  it('gives every threat its own named file, and has no file for a threat it does not know', () => {
    const named = readdirSync(import.meta.dirname)
      .filter((name) => /^T\d+-/u.test(name))
      .sort();

    expect(named).toEqual(THREATS.map((threat) => `${threat.id}-${threat.slug}.test.ts`).sort());
  });

  it('names every gap after the row that will close it', () => {
    for (const threat of THREATS) {
      for (const gap of threat.gaps) expect(gap.row, threat.id).toMatch(/^P\d+-\d+[a-z]?$/u);
    }
  });
});
