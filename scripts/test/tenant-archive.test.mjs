import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

import { archiveFiles, confirmed, parseArgs, tenantArg, toCsv } from '../lib/tenant-archive.mjs';

/**
 * The winery archive and the erasure's confirmation (P7-08), without a
 * database: what the export writes, and what the erasure will and will not take
 * as a yes. The database half is `packages/db/test/tenant-data.integration.test.ts`.
 */

const ROOT = resolve(import.meta.dirname, '..', '..');

describe('the CSV', () => {
  it('quotes a cell with a comma, a quote or a line break, and doubles its quotes', () => {
    expect(
      toCsv([{ name: 'Rosso, "riserva"', note: 'due\nrighe', plain: 'Barolo', price: 2000 }]),
    ).toBe('name,note,plain,price\r\n"Rosso, ""riserva""","due\nrighe",Barolo,2000\r\n');
  });

  it('writes nothing for a missing value, a date as ISO, and anything structured as JSON', () => {
    expect(
      toCsv([
        {
          gone: null,
          absent: undefined,
          at: new Date('2026-10-18T09:30:00Z'),
          metadata: { rows: 9 },
          tags: ['a', 'b'],
        },
      ]),
    ).toBe(
      'gone,absent,at,metadata,tags\r\n,,2026-10-18T09:30:00.000Z,"{""rows"":9}","[""a"",""b""]"\r\n',
    );
  });

  it('has every column any row has, and an empty table is an empty file', () => {
    expect(toCsv([{ a: 1 }, { b: 2 }])).toBe('a,b\r\n1,\r\n,2\r\n');
    expect(toCsv([])).toBe('');
  });
});

describe('the archive', () => {
  const data = {
    tenant: { id: 't', name: 'Cantina srl' },
    members: [{ id: 'u', email: 'giulia@example.test', role: 'OWNER' }],
    tables: { products: [{ sku: 'a' }, { sku: 'b' }], audit_log: [] },
  };

  it('is the winery, its members, and each table as JSON and CSV, with a manifest of what is and is not there', () => {
    const files = archiveFiles(data, {
      tenantId: 't',
      exportedAt: '2026-10-18T09:30:00.000Z',
      notExported: { product_embeddings: 'derived' },
    });

    expect(Object.keys(files).sort()).toEqual([
      'manifest.json',
      'members.csv',
      'members.json',
      'tables/audit_log.csv',
      'tables/audit_log.json',
      'tables/products.csv',
      'tables/products.json',
      'tenant.json',
    ]);
    expect(JSON.parse(files['tables/products.json'])).toEqual(data.tables.products);
    expect(files['tables/products.csv']).toBe('sku\r\na\r\nb\r\n');
    expect(JSON.parse(files['manifest.json'])).toMatchObject({
      tenantId: 't',
      exportedAt: '2026-10-18T09:30:00.000Z',
      members: 1,
      tables: { products: 2, audit_log: 0 },
      notExported: { product_embeddings: 'derived' },
    });
  });
});

describe('the confirmation', () => {
  it('is the slug exactly, with the line’s end and nothing else forgiven', () => {
    expect(confirmed('cantina-rossi', 'cantina-rossi')).toBe(true);
    expect(confirmed('cantina-rossi', 'cantina-rossi\n')).toBe(true);
    expect(confirmed('cantina-rossi', 'cantina-rossi\r\n')).toBe(true);

    for (const typed of [
      '',
      'y',
      'yes',
      'Cantina-Rossi',
      ' cantina-rossi',
      'cantina-rossi ',
      'cantina',
    ]) {
      expect(confirmed('cantina-rossi', typed), JSON.stringify(typed)).toBe(false);
    }

    expect(confirmed('cantina-rossi', undefined)).toBe(false);
  });
});

describe('the arguments', () => {
  it('reads --name value pairs and --flags, and refuses anything else', () => {
    expect(parseArgs(['--tenant', 'x', '--execute'])).toEqual({ tenant: 'x', execute: true });
    expect(parseArgs(['--execute', '--tenant', 'x'])).toEqual({ tenant: 'x', execute: true });
    expect(() => parseArgs(['x'])).toThrow(/Unexpected argument/u);
  });

  it('wants a uuid for the winery, and nothing short of one', () => {
    const id = randomUUID();

    expect(tenantArg({ tenant: id.toUpperCase() })).toBe(id);

    for (const tenant of [undefined, true, '', 'cantina-rossi', `${id} OR 1=1`, id.slice(1)]) {
      expect(() => tenantArg({ tenant }), String(tenant)).toThrow(/--tenant <uuid>/u);
    }
  });
});

/**
 * The scripts themselves, run as an operator runs them, with nothing to connect
 * to: each refuses before it reaches for a database.
 */
describe('the scripts', () => {
  const run = (script, args, env = {}) =>
    spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      timeout: 30_000,
    });

  it.each([
    ['tenant-export.mjs', [], /--tenant <uuid>/u],
    ['tenant-export.mjs', ['--tenant', randomUUID()], /DATABASE_URL is not set/u],
    ['tenant-delete.mjs', ['--tenant', 'cantina-rossi'], /--tenant <uuid>/u],
    [
      'tenant-delete.mjs',
      ['--tenant', randomUUID(), '--execute'],
      /ERASURE_DATABASE_URL is not set/u,
    ],
  ])('%s %j refuses', (script, args, words) => {
    const result = run(script, args);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(words);
  });

  it('the erasure will not take the runtime’s DATABASE_URL in place of its own', () => {
    const result = run('tenant-delete.mjs', ['--tenant', randomUUID()], {
      DATABASE_URL: 'postgres://app_rw@127.0.0.1:1/catalogorosso',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ERASURE_DATABASE_URL is not set/u);
  });
});
