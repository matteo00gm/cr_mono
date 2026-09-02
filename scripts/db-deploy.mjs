#!/usr/bin/env node
/**
 * Applies `bootstrap/` as master, then `migrations/` as `app_migrate` (P0-21b).
 *
 * P0 otherwise has no deploy-time path: bootstrap and migrations are applied by
 * hand and by the test fixtures, which is fine while no stage holds data and
 * stops being fine the moment one does. Left unstated it becomes someone
 * running `psql` against production from a laptop.
 *
 * **Where this runs.** In-VPC — an SST task or a one-shot Lambda invoked after
 * deploy. RDS sits in private subnets: there is egress (`nat: "ec2"`) but no
 * inbound path, so a GitHub-hosted runner cannot reach the instance at all.
 *
 * **Credentials arrive as environment variables**, not read from SSM here. The
 * invoker already holds the parameter values as deploy-time outputs, so adding
 * an AWS SDK dependency to fetch what the caller can simply pass would buy
 * nothing and would make this script untestable without mocking AWS. The
 * parameters are `database/master_url`, `database/app_rw_password` and
 * `database/app_migrate_password` — the two that P0-21a refuses to grant to
 * application functions.
 */
import process from 'node:process';

import { applyBootstrap, applyMigrations, withRole } from '../packages/db/dist/deploy.js';

const REQUIRED = ['DATABASE_MASTER_URL', 'APP_RW_PASSWORD', 'APP_MIGRATE_PASSWORD'];

const main = async () => {
  const missing = REQUIRED.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    // Named individually rather than "missing configuration": a deploy that
    // fails at 3am should say which value to go and set.
    console.error(`db-deploy: missing required environment: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const masterUrl = process.env.DATABASE_MASTER_URL;
  const passwords = {
    app_rw: process.env.APP_RW_PASSWORD,
    app_migrate: process.env.APP_MIGRATE_PASSWORD,
  };

  // Bootstrap first, and as master: CREATE ROLE and CREATE EXTENSION need
  // privileges app_migrate does not have, and app_migrate cannot create itself.
  // It is idempotent, so re-running a deploy is not a special case.
  console.log('db-deploy: applying bootstrap as master');
  await applyBootstrap(masterUrl, passwords);

  // Then migrations as app_migrate, derived from the same URL so the two
  // cannot disagree about which database they point at. Whoever runs a
  // migration owns the tables it creates, and FORCE ROW LEVEL SECURITY does
  // not apply to a table's owner — so this must not be the master and must not
  // be app_rw.
  console.log('db-deploy: applying migrations as app_migrate');
  await applyMigrations(withRole(masterUrl, 'app_migrate', passwords.app_migrate));

  console.log('db-deploy: done');
};

await main();
