import {
  ListMessageMoveTasksCommand,
  StartMessageMoveTaskCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';

import { redriveDlq } from '../src/redrive-dlq.js';

/**
 * Sending the embedding DLQ back to its queue (P1-50).
 *
 * The client is a fake that answers each command by type, so this runs without
 * AWS. What it pins is the part that can go wrong quietly: which queue is the
 * source, and that a second run while a move is under way starts nothing.
 */

const DLQ = 'arn:aws:sqs:eu-west-1:000000000000:EmbeddingDlq';
const QUEUE = 'arn:aws:sqs:eu-west-1:000000000000:EmbeddingQueue';

interface Task {
  readonly Status: string;
  readonly TaskHandle?: string;
  readonly ApproximateNumberOfMessagesMoved?: number;
  readonly ApproximateNumberOfMessagesToMove?: number;
}

const clientListing = (tasks: readonly Task[] | undefined) => {
  const send = vi.fn((command: unknown) =>
    Promise.resolve(
      command instanceof ListMessageMoveTasksCommand
        ? tasks === undefined
          ? {}
          : { Results: tasks }
        : { TaskHandle: 'task-new' },
    ),
  );

  return { send, client: { send } as unknown as SQSClient };
};

describe('redriveDlq', () => {
  it('starts one move from the DLQ to the queue when none is running', async () => {
    const { send, client } = clientListing([{ Status: 'COMPLETED', TaskHandle: 'task-old' }]);

    expect(await redriveDlq({ client, dlqArn: DLQ, queueArn: QUEUE })).toEqual({
      outcome: 'started',
      taskHandle: 'task-new',
    });

    const [list, start] = send.mock.calls.map(([command]) => command);
    expect(list).toBeInstanceOf(ListMessageMoveTasksCommand);
    expect((list as ListMessageMoveTasksCommand).input).toEqual({ SourceArn: DLQ, MaxResults: 10 });
    expect(start).toBeInstanceOf(StartMessageMoveTaskCommand);
    expect((start as StartMessageMoveTaskCommand).input).toEqual({
      SourceArn: DLQ,
      DestinationArn: QUEUE,
    });
  });

  it('starts a move when the DLQ has never had one', async () => {
    const { send, client } = clientListing(undefined);

    expect((await redriveDlq({ client, dlqArn: DLQ, queueArn: QUEUE })).outcome).toBe('started');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('starts nothing while a move is already running, so running it twice is safe', async () => {
    const { send, client } = clientListing([
      { Status: 'COMPLETED', TaskHandle: 'task-old' },
      {
        Status: 'RUNNING',
        TaskHandle: 'task-live',
        ApproximateNumberOfMessagesMoved: 3,
        ApproximateNumberOfMessagesToMove: 10,
      },
    ]);

    expect(await redriveDlq({ client, dlqArn: DLQ, queueArn: QUEUE })).toEqual({
      outcome: 'already-running',
      taskHandle: 'task-live',
      moved: 3,
      total: 10,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses to move a queue onto itself, before asking SQS anything', async () => {
    const { send, client } = clientListing([]);

    await expect(redriveDlq({ client, dlqArn: DLQ, queueArn: DLQ })).rejects.toThrow(/same queue/);
    expect(send).not.toHaveBeenCalled();
  });

  it('builds its own client when none is supplied', async () => {
    // Pointed at a closed local port, so construction is exercised and nothing leaves the machine.
    await expect(
      redriveDlq({
        dlqArn: DLQ,
        queueArn: QUEUE,
        config: {
          region: 'eu-west-1',
          endpoint: 'http://127.0.0.1:9',
          maxAttempts: 1,
          credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
        },
      }),
    ).rejects.toThrow();
  }, 15_000);
});
