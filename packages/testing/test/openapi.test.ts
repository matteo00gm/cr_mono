import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The generated OpenAPI document (P0-62).
 *
 * Asserted against the committed artifact rather than by re-running the
 * generator for every case: the drift check already proves the committed file
 * matches what the generator emits, so testing the file tests both.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');
const doc = JSON.parse(readFileSync(join(ROOT, 'docs', 'api', 'openapi.json'), 'utf8')) as {
  dashboard: Surface;
  widget: Surface;
};

interface Operation {
  summary?: string;
  description?: string;
  operationId?: string;
  responses?: Record<string, { description?: string; content?: unknown }>;
  'x-required-capability'?: string;
}
interface Surface {
  openapi: string;
  info: { title: string; description: string; version: string };
  paths: Record<string, Record<string, Operation>>;
}

const operations = (surface: Surface): [string, string, Operation][] =>
  Object.entries(surface.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(
      ([method, op]) => [path, method, op] as [string, string, Operation],
    ),
  );

describe('the document', () => {
  it('declares an OpenAPI version and info on both surfaces', () => {
    for (const surface of [doc.dashboard, doc.widget]) {
      expect(surface.openapi).toBe('3.1.0');
      expect(surface.info.title.length).toBeGreaterThan(0);
      expect(surface.info.description.length).toBeGreaterThan(0);
    }
  });

  it('documents the two surfaces separately', () => {
    /*
     * `/v1/widget/*` is public-facing and `/v1/dashboard/*` is not. Merging
     * them would put an internal reference in front of sellers' developers.
     */
    expect(doc.dashboard.info.title).not.toBe(doc.widget.info.title);
    for (const [path] of operations(doc.dashboard))
      expect(path.startsWith('/v1/dashboard')).toBe(true);
  });

  it('is not empty, or every assertion below is vacuous', () => {
    expect(operations(doc.dashboard).length).toBeGreaterThan(0);
  });
});

describe('every operation', () => {
  it('has a summary, a description and an operation id', () => {
    // A reference where half the routes are blank is decorative. The generator
    // refuses to emit one; this is the assertion that says so out loud.
    for (const [path, method, op] of operations(doc.dashboard)) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(op.summary?.trim(), where).toBeTruthy();
      expect(op.description?.trim(), where).toBeTruthy();
      expect(op.operationId?.trim(), where).toBeTruthy();
    }
  });

  it('has a unique operation id', () => {
    // Duplicate ids break every client generator, including P0-63's.
    const ids = operations(doc.dashboard).map(([, , op]) => op.operationId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('documents a success and both refusals', () => {
    for (const [path, method, op] of operations(doc.dashboard)) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(Object.keys(op.responses ?? {}), where).toEqual(['200', '401', '403']);
    }
  });

  it('carries a concrete example, never a type name', () => {
    /*
     * `"string"` as an example is the shape a generator emits when nobody
     * supplied one, and it teaches a reader nothing about what the field holds.
     */
    for (const [path, method, op] of operations(doc.dashboard)) {
      const example = op.responses?.['200']?.content as
        { 'application/json'?: { example?: unknown } } | undefined;
      const value = example?.['application/json']?.example;

      expect(value, `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(JSON.stringify(value)).not.toContain('"string"');
    }
  });

  it('says who may call it', () => {
    // The part a reader cannot get anywhere else: otherwise the only way to
    // learn a route's required capability is to try it and be refused.
    for (const [path, method, op] of operations(doc.dashboard)) {
      const where = `${method.toUpperCase()} ${path}`;
      const stated =
        op['x-required-capability'] !== undefined ||
        (op.description ?? '').includes('No capability required');

      expect(stated, where).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('emits byte-identical output across runs', () => {
    /*
     * Unstable key ordering would make the drift check fail for no reason, and
     * a check that fails spuriously gets disabled — which is how this artifact
     * dies. Every level is sorted for exactly this assertion.
     */
    const run = (): string => {
      execFileSync('node', [join(ROOT, 'scripts', 'gen-openapi.mjs')], { cwd: ROOT });
      return readFileSync(join(ROOT, 'docs', 'api', 'openapi.json'), 'utf8');
    };

    expect(run()).toBe(run());
  }, 60_000);
});
