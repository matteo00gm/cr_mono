#!/usr/bin/env node
/**
 * Erases one winery, keeping its fiscal records (P7-08, ADR 0033). See
 * `docs/runbooks/gdpr.md` — and run `tenant-export.mjs` first.
 *
 *     ERASURE_DATABASE_URL=<app_migrate> node scripts/tenant-delete.mjs --tenant <uuid>
 *     ERASURE_DATABASE_URL=<app_migrate> node scripts/tenant-delete.mjs --tenant <uuid> --execute [--out <dir>]
 *
 * **A dry run unless told otherwise**: without `--execute` it says what would
 * go and changes nothing. With it, it asks for the winery's slug to be typed,
 * and erases only on an exact match.
 *
 * **As the migration role**, because the runtime role cannot delete a winery
 * (migration 0029). It connects with its own client, which is why it imports
 * the client module directly; nothing in a request can reach this.
 *
 * **The receipt is the record.** The winery's own audit log goes with it, so
 * what was erased, when and by whom is written to a file kept with the request
 * that asked for it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';

import { createDbClient } from '../packages/db/dist/client.js';
import { eraseTenant } from '../packages/db/dist/index.js';
import { confirmed, parseArgs, tenantArg } from './lib/tenant-archive.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const tenantId = tenantArg(args);
  const url = process.env.ERASURE_DATABASE_URL;

  if (!url) throw new Error('ERASURE_DATABASE_URL is not set (the app_migrate role).');

  const client = createDbClient(url, { max: 1 });

  try {
    const planned = await eraseTenant(client.db, tenantId, { dryRun: true });

    process.stdout.write(`${JSON.stringify(planned, null, 2)}\n`);

    if (args.execute !== true) {
      process.stdout.write('Dry run: nothing was erased. Add --execute to erase.\n');
      return;
    }

    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await prompt.question(`Type the winery's slug (${planned.slug}) to erase it: `);

    prompt.close();

    if (!confirmed(planned.slug, typed)) {
      process.stdout.write('That is not the slug. Nothing was erased.\n');
      process.exitCode = 1;
      return;
    }

    const receipt = {
      ...(await eraseTenant(client.db, tenantId, { dryRun: false })),
      erasedAt: new Date().toISOString(),
      operator: process.env.USER ?? process.env.USERNAME ?? 'unknown',
    };
    const dir = typeof args.out === 'string' ? resolve(args.out) : join(ROOT, 'exports');
    const out = join(dir, `${tenantId}-erasure-receipt.json`);

    mkdirSync(dir, { recursive: true });
    writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);

    process.stdout.write(`Erased. Receipt: ${out}\n`);

    /* Not in the database, so not erased with it (ADR 0031): the runbook's last step. */
    for (const shop of receipt.shopsConnected) {
      process.stdout.write(
        `Still to remove by hand: the token parameter /sommelier/<stage>/shopify/${tenantId}/${shop}\n`,
      );
    }
  } finally {
    await client.close();
  }
};

main().catch((error) => {
  process.stderr.write(
    `tenant-delete: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
