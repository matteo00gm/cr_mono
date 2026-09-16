import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Which models each function may invoke (P1-36, P2-37).
 *
 * **A wildcard here costs money rather than data**, which is why it needs a
 * test: `bedrock:InvokeModel` on `*` still passes review, still deploys, still
 * works — and the first sign of a bug invoking Claude Opus in a loop instead of
 * Titan is the bill at the end of the month. There is no error, no alarm and no
 * log line, because nothing has gone wrong from AWS's point of view.
 *
 * `api.ts` and `queue.ts` build resources at import and cannot be loaded here,
 * so this reads their source. Blunt, and still the only thing that fails if
 * somebody widens a resource list to get an unrelated model working.
 */

const sourceOf = (module: string): string =>
  readFileSync(fileURLToPath(new URL(`../${module}`, import.meta.url)), 'utf8');

const TITAN = /foundation-model\/amazon\.titan-embed-text-v2:0/;

describe.each([
  ['api.ts', 'the retrieval sandbox, and P2-29 next'],
  ['queue.ts', 'the embedding worker'],
])('%s', (module, why) => {
  const source = sourceOf(module);

  it(`invokes Titan and names it, for ${why}`, () => {
    expect(source).toMatch(/actions: \['bedrock:InvokeModel'\]/);
    expect(source).toMatch(TITAN);
  });

  it('never grants a model by wildcard', () => {
    /*
     * The failure this file exists for. `resources: ['*']` beside an
     * `InvokeModel` action is one careless line, and it is indistinguishable
     * from the correct version in every place except an invoice.
     */
    const grants = [...source.matchAll(/actions: \['bedrock:InvokeModel'\][\S\s]{0,400}?\],/g)];

    expect(grants.length).toBeGreaterThan(0);

    for (const [grant] of grants) {
      expect(grant).not.toContain("'*'");
      expect(grant).toMatch(TITAN);
    }
  });
});
