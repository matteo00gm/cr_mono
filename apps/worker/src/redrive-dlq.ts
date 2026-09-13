import {
  ListMessageMoveTasksCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs';

/**
 * Sends the embedding dead-letter queue back to the embedding queue (P1-50).
 *
 * **SQS's own message-move task, not a receive-send-delete loop.** A loop that
 * crashes between sending a copy and deleting the original duplicates a
 * message, and one that deletes first loses it; the move task is done by SQS
 * between its own queues and has neither gap. Redelivery is harmless at the far
 * end either way: the worker skips a wine whose vector is already current.
 *
 * **It refuses to start a second move while one is running**, so the operator
 * who runs it twice — which is what people do when a command prints nothing
 * for a minute — gets told, rather than two tasks racing over one queue.
 *
 * Run by a person, by the procedure in `docs/runbooks/embedding-failures.md`,
 * with their own credentials. Nothing in CI or the deployed system calls it.
 */

export interface RedriveOptions {
  readonly dlqArn: string;
  readonly queueArn: string;
  readonly client?: SQSClient | undefined;
  readonly config?: SQSClientConfig | undefined;
}

export type RedriveOutcome =
  | { readonly outcome: 'started'; readonly taskHandle: string | undefined }
  | {
      readonly outcome: 'already-running';
      readonly taskHandle: string | undefined;
      readonly moved: number | undefined;
      readonly total: number | undefined;
    };

export const redriveDlq = async (options: RedriveOptions): Promise<RedriveOutcome> => {
  if (options.dlqArn === options.queueArn) {
    throw new Error(
      'redriveDlq: the dead-letter queue and the destination are the same queue, so nothing would move.',
    );
  }

  const client = options.client ?? new SQSClient(options.config ?? {});

  const listed = await client.send(
    new ListMessageMoveTasksCommand({ SourceArn: options.dlqArn, MaxResults: 10 }),
  );
  const running = (listed.Results ?? []).find((task) => task.Status === 'RUNNING');

  if (running !== undefined) {
    return {
      outcome: 'already-running',
      taskHandle: running.TaskHandle,
      moved: running.ApproximateNumberOfMessagesMoved,
      total: running.ApproximateNumberOfMessagesToMove,
    };
  }

  const started = await client.send(
    new StartMessageMoveTaskCommand({
      SourceArn: options.dlqArn,
      DestinationArn: options.queueArn,
    }),
  );

  return { outcome: 'started', taskHandle: started.TaskHandle };
};
