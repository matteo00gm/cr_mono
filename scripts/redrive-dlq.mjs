#!/usr/bin/env node
/**
 * Moves every message in the embedding dead-letter queue back to the embedding
 * queue (P1-50).
 *
 * Run by a person, after the cause is fixed, by the procedure in
 * `docs/runbooks/embedding-failures.md`. It uses whatever AWS credentials the
 * shell has, and needs `sqs:ListMessageMoveTasks` and `sqs:StartMessageMoveTask`
 * on the DLQ. Nothing in CI runs it.
 *
 * The worker is imported from `dist`, so this needs `pnpm build` first.
 *
 * Usage:
 *   EMBEDDING_DLQ_ARN=arn:... EMBEDDING_QUEUE_ARN=arn:... node scripts/redrive-dlq.mjs
 */
import process from 'node:process';
import { die as reportDie } from './lib/report.mjs';

const die = (msg) => reportDie('DLQ redrive failed: ' + msg);

const dlqArn = process.env.EMBEDDING_DLQ_ARN;
const queueArn = process.env.EMBEDDING_QUEUE_ARN;

if (!dlqArn || !queueArn) {
  die(
    'set EMBEDDING_DLQ_ARN to the dead-letter queue and EMBEDDING_QUEUE_ARN to the queue it ' +
      'feeds. Both are in the SST outputs for the stage; the runbook says where.',
  );
}

const { redriveDlq } = await import('../apps/worker/dist/redrive-dlq.js');
const result = await redriveDlq({ dlqArn, queueArn });

process.stdout.write(
  result.outcome === 'started'
    ? `Started moving the DLQ back to the queue (task ${String(result.taskHandle)}).\n`
    : `A move is already running (task ${String(result.taskHandle)}, ` +
        `${String(result.moved)} of ${String(result.total)} moved). Nothing new was started.\n`,
);
