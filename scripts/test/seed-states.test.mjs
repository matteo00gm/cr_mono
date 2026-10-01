import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

/**
 * The state seeder's guard rails (P5-14). What it seeds is asserted against
 * Postgres in `billing-states.integration.test.ts`; these are its refusals,
 * which are exit statuses and so only mean anything from outside.
 */

const SCRIPT = join(resolve(import.meta.dirname, '..', '..'), 'scripts', 'seed-states.mjs');

const run = (args, env) =>
  new Promise((finished) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    });
    let output = '';

    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('close', (status) => finished({ status, output }));
  });

describe('the state seeder', () => {
  it('refuses production, whatever database it is pointed at', async () => {
    const { status, output } = await run([], {
      SST_STAGE: 'production',
      DATABASE_URL: 'postgres://app_rw:x@localhost:1/none',
    });

    expect(status).toBe(1);
    expect(output).toContain('Refusing to seed fixture wineries into production');
  });

  it('refuses to run without a database', async () => {
    const { status, output } = await run([], {});

    expect(status).toBe(1);
    expect(output).toContain('DATABASE_URL is not set');
  });

  it('refuses an argument it does not know', async () => {
    const { status, output } = await run(['--serv'], {});

    expect(status).toBe(1);
    expect(output).toContain('Unknown argument --serv');
  });
});
