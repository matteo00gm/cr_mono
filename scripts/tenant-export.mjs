#!/usr/bin/env node
/**
 * One winery's data, whole, as JSON and CSV (P7-08). See `docs/runbooks/gdpr.md`.
 *
 *     DATABASE_URL=<app_rw> node scripts/tenant-export.mjs --tenant <uuid> [--out <dir>]
 *
 * **As the runtime role, in the winery's own scope**: the export reads through
 * `withTenant`, so the archive cannot hold another winery's row whatever a
 * query says, and it is recorded in that winery's audit log in the same
 * transaction. Written under `exports/`, which git ignores; where the archive
 * goes from there is the runbook's.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import {
  NOT_EXPORTED,
  readTenantExport,
  recordExport,
  withTenant,
} from '../packages/db/dist/index.js';
import { archiveFiles, parseArgs, tenantArg } from './lib/tenant-archive.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = tenantArg(args);

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (the app_rw role).');

  const exportedAt = new Date().toISOString();
  const data = await withTenant(tenantId, async (tx) => {
    const read = await readTenantExport(tx, tenantId);

    if (read !== undefined) {
      await recordExport(
        tx,
        tenantId,
        Object.values(read.tables).reduce((n, rows) => n + rows.length, 0),
      );
    }

    return read;
  });

  if (data === undefined) throw new Error(`There is no winery ${tenantId}.`);

  const out =
    typeof args.out === 'string'
      ? resolve(args.out)
      : join(ROOT, 'exports', `${tenantId}-${exportedAt.slice(0, 10)}`);

  const files = archiveFiles(data, { tenantId, exportedAt, notExported: NOT_EXPORTED });

  for (const [name, content] of Object.entries(files)) {
    const path = join(out, name);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  process.stdout.write(`Exported ${String(Object.keys(files).length)} files to ${out}\n`);
};

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(
      `tenant-export: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  },
);
