import type { OutboxJob, OutboxPass } from '@catalogorosso/db';
import { describe, expect, it, vi } from 'vitest';

import { handler, pollOutbox, sqsPublisher, type EmbeddingMessage } from '../src/outbox-poller.js';

/**
 * The outbox poller (P1-31).
 *
 * The SQS client and the transaction are both injected, so none of this needs
 * AWS or a database — the parts that do need a database (the claim itself, and
 * that two pollers never take the same row) are in
 * `packages/db/test/outbox.integration.test.ts`, where a real `SKIP LOCKED` is
 * the only thing that can demonstrate it.
 */

const job = (id: number, over: Partial<OutboxJob> = {}): OutboxJob => ({
  id,
  tenantId: '11111111-1111-4111-8111-111111111111',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  eventType: 'embedding.requested',
  payload: { reason: 'created' },
  attempts: 0,
  ...over,
});

const jobs = (count: number): readonly OutboxJob[] =>
  Array.from({ length: count }, (_, index) => job(index + 1));

interface BatchInput {
  readonly QueueUrl: string;
  readonly Entries: readonly { readonly Id: string; readonly MessageBody: string }[];
}

/** All entries sent, and a canned reply for each call. */
const client = (reply: (input: BatchInput) => unknown) => {
  const sent: BatchInput[] = [];
  const send = vi.fn((command: { input: BatchInput }) => {
    sent.push(command.input);
    return Promise.resolve(reply(command.input));
  });

  return { send, sent, asClient: { send } as never };
};

/** Sets the queue variable for one test and puts it back afterwards. */
const withQueueUrl = async (value: string | undefined, run: () => Promise<void>): Promise<void> => {
  const previous = process.env.EMBEDDING_QUEUE_URL;

  if (value === undefined) delete process.env.EMBEDDING_QUEUE_URL;
  else process.env.EMBEDDING_QUEUE_URL = value;

  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.EMBEDDING_QUEUE_URL;
    else process.env.EMBEDDING_QUEUE_URL = previous;
  }
};

const allSucceed = (input: BatchInput) => ({
  Successful: input.Entries.map((entry) => ({ Id: entry.Id })),
  Failed: [],
});

describe('the message', () => {
  it('carries a pointer to the product rather than the product', async () => {
    /*
     * **The property the whole design rests on.** Because the message names a
     * product instead of describing one, the worker re-reads the row and embeds
     * whatever is current — so a redelivery is a no-op and two edits delivered
     * out of order still end at the right text. A message carrying the tasting
     * note would make both of those wrong, and neither would show up as an
     * error: the wine would simply be described by a version of itself nobody
     * can see any more.
     */
    const fake = client(allSucceed);

    await sqsPublisher({ client: fake.asClient, queueUrl: 'q' })([
      job(7, { payload: { reason: 'edited' } }),
    ]);

    const entry = fake.sent[0]?.Entries[0];
    const message = JSON.parse(entry?.MessageBody ?? '{}') as EmbeddingMessage;

    expect(message).toEqual({
      outboxId: 7,
      tenantId: '11111111-1111-4111-8111-111111111111',
      productId: '22222222-2222-4222-8222-222222222222',
      reason: 'edited',
    });
  });

  it('falls back to the event type when the payload says nothing', async () => {
    const fake = client(allSucceed);

    await sqsPublisher({ client: fake.asClient, queueUrl: 'q' })([job(1, { payload: null })]);

    const message = JSON.parse(fake.sent[0]?.Entries[0]?.MessageBody ?? '{}') as EmbeddingMessage;

    expect(message.reason).toBe('embedding.requested');
  });

  it('uses the outbox id as the batch entry id', async () => {
    /*
     * Not cosmetic: the id is how a `Successful` entry is matched back to the
     * row it came from. A generated id would need a lookup table, and getting
     * that mapping wrong would mark the wrong rows published — losing one job
     * and re-sending another, silently.
     */
    const fake = client(allSucceed);

    await sqsPublisher({ client: fake.asClient, queueUrl: 'q' })([job(42)]);

    expect(fake.sent[0]?.Entries[0]?.Id).toBe('42');
  });
});

describe('batching', () => {
  it('sends ten at a time, which is the API maximum', async () => {
    const fake = client(allSucceed);

    await sqsPublisher({ client: fake.asClient, queueUrl: 'q' })(jobs(25));

    expect(fake.sent.map((input) => input.Entries.length)).toEqual([10, 10, 5]);
  });

  it('sends nothing for an empty claim', async () => {
    const fake = client(allSucceed);

    expect(await sqsPublisher({ client: fake.asClient, queueUrl: 'q' })([])).toEqual([]);
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('reports only the entries SQS confirmed', async () => {
    /*
     * **Per-entry, not per-batch.** Nine of ten landing is the ordinary case,
     * and counting the batch as failed would re-send those nine on the next
     * pass — nine duplicate embeddings for one failure, every time.
     */
    const fake = client((input) => ({
      Successful: input.Entries.slice(1).map((entry) => ({ Id: entry.Id })),
      Failed: [{ Id: input.Entries[0]?.Id, Code: 'InternalError' }],
    }));

    const published = await sqsPublisher({ client: fake.asClient, queueUrl: 'q' })(jobs(3));

    expect(published).toEqual([2, 3]);
  });

  it('keeps going after a chunk that never reached the service', async () => {
    /*
     * A throw is not a `Failed` entry: the request did not arrive, so nothing
     * in that chunk published. Propagating it would abandon the chunks behind
     * it as well, turning one transient error into a whole pass wasted.
     */
    let call = 0;
    const fake = client((input) => {
      call += 1;
      if (call === 1) throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
      return allSucceed(input);
    });

    const published = await sqsPublisher({ client: fake.asClient, queueUrl: 'q' })(jobs(15));

    expect(published).toEqual([11, 12, 13, 14, 15]);
  });
});

describe('what a failure is allowed to say', () => {
  it('logs the code, never the provider message', async () => {
    /*
     * **P0-56 applied to a log rather than to a response.** A provider's
     * message is free text and has historically carried endpoints and
     * credentials; the code is a closed set. This is written as a test rather
     * than a comment because the tempting change — "include the message, it
     * would help debugging" — is one line and reads as an improvement.
     */
    const fake = client((input) => ({
      Successful: [],
      Failed: input.Entries.map((entry) => ({
        Id: entry.Id,
        Code: 'InvalidParameterValue',
        Message: 'endpoint https://user:secret@sqs.example/queue rejected the request',
      })),
    }));

    const failures: { id: number; reason: string }[] = [];

    await sqsPublisher({
      client: fake.asClient,
      queueUrl: 'q',
      onFailure: (info) => failures.push(info),
    })([job(1)]);

    expect(failures).toEqual([{ id: 1, reason: 'InvalidParameterValue' }]);
  });

  it('logs the error name when the request threw', async () => {
    const fake = client(() => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
        name: 'TimeoutError',
      });
    });

    const failures: { id: number; reason: string }[] = [];

    await sqsPublisher({
      client: fake.asClient,
      queueUrl: 'q',
      onFailure: (info) => failures.push(info),
    })([job(1)]);

    expect(failures).toEqual([{ id: 1, reason: 'TimeoutError' }]);
  });
});

/** A `runOutboxPass` stand-in that replays the given results in order. */
const passes = (results: readonly Partial<OutboxPass>[]) => {
  let index = 0;

  return vi.fn(() => {
    const result = results[index] ?? { claimed: 0, published: 0, failed: 0 };
    index += 1;

    return Promise.resolve({
      claimed: result.claimed ?? 0,
      published: result.published ?? 0,
      failed: result.failed ?? 0,
    });
  });
};

describe('draining', () => {
  const publish = () => Promise.resolve([]);

  it('keeps going while the batches come back full', async () => {
    /*
     * One pass per schedule tick would drain a 5,000-wine import at a hundred a
     * minute — most of an hour with the catalogue half-searchable and nothing
     * reporting a problem.
     */
    const runPass = passes([
      { claimed: 10, published: 10 },
      { claimed: 10, published: 10 },
      { claimed: 4, published: 4 },
    ]);

    const result = await pollOutbox(publish, { limit: 10, runPass });

    expect(result).toEqual({ passes: 3, claimed: 24, published: 24, failed: 0 });
  });

  it('stops on a short batch rather than asking again for nothing', async () => {
    const runPass = passes([{ claimed: 3, published: 3 }]);

    await pollOutbox(publish, { limit: 10, runPass });

    expect(runPass).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty queue', async () => {
    const runPass = passes([{ claimed: 0, published: 0 }]);

    const result = await pollOutbox(publish, { limit: 10, runPass });

    expect(result.passes).toBe(1);
    expect(runPass).toHaveBeenCalledTimes(1);
  });

  it('stops when a full batch published nothing at all', async () => {
    /*
     * **The rule that keeps an outage from becoming a data loss.** Every pass
     * that fails to publish increments `attempts` on everything it claimed, and
     * past `MAX_PUBLISH_ATTEMPTS` those rows stop being claimed at all. Nineteen
     * more rounds against an unreachable queue would burn through that budget
     * for two hundred wines in a single invocation.
     */
    const runPass = passes([
      { claimed: 10, published: 0, failed: 10 },
      { claimed: 10, published: 10 },
    ]);

    const result = await pollOutbox(publish, { limit: 10, runPass });

    expect(result).toEqual({ passes: 1, claimed: 10, published: 0, failed: 10 });
    expect(runPass).toHaveBeenCalledTimes(1);
  });

  it('keeps going when a batch published only some of what it claimed', async () => {
    // Partial progress is progress: the queue is reachable and the rows that
    // missed are still claimable next time.
    const runPass = passes([
      { claimed: 10, published: 8, failed: 2 },
      { claimed: 2, published: 2 },
    ]);

    const result = await pollOutbox(publish, { limit: 10, runPass });

    expect(result).toEqual({ passes: 2, claimed: 12, published: 10, failed: 2 });
  });

  it('has a ceiling, because a Lambda has a wall clock', async () => {
    const runPass = passes(Array.from({ length: 50 }, () => ({ claimed: 10, published: 10 })));

    const result = await pollOutbox(publish, { limit: 10, maxPasses: 3, runPass });

    expect(result.passes).toBe(3);
  });
});

describe('its defaults', () => {
  it('builds its own SQS client when none is supplied', () => {
    /*
     * Construction only — no call is made — so this needs no credentials and no
     * network. What it pins is that the production path does not require an
     * injected client, which is the shape every other test here bypasses.
     */
    expect(() => sqsPublisher({ queueUrl: 'q' })).not.toThrow();
  });

  it('claims a hundred a pass when no limit is given', async () => {
    const runPass = passes([
      { claimed: 100, published: 100 },
      { claimed: 1, published: 1 },
    ]);

    await pollOutbox(() => Promise.resolve([]), { runPass });

    // A full batch at the default limit, so it went round again rather than
    // stopping on what it could not tell apart from a short one.
    expect(runPass).toHaveBeenCalledTimes(2);
  });

  it('survives a reply with neither list in it', async () => {
    /*
     * `Successful` and `Failed` are both optional in the SDK's types. A reply
     * carrying neither is not something SQS does, and reading `.length` off
     * undefined in a poller would take down the drain for every tenant.
     */
    const fake = client(() => ({}));

    expect(await sqsPublisher({ client: fake.asClient, queueUrl: 'q' })([job(1)])).toEqual([]);
  });

  it('says "unknown" rather than nothing when a failure carries no code', async () => {
    const fake = client((input) => ({
      Successful: [],
      Failed: input.Entries.map((entry) => ({ Id: entry.Id })),
    }));

    const failures: { id: number; reason: string }[] = [];

    await sqsPublisher({
      client: fake.asClient,
      queueUrl: 'q',
      onFailure: (info) => failures.push(info),
    })([job(1)]);

    expect(failures).toEqual([{ id: 1, reason: 'unknown' }]);
  });

  it('says "unknown" for a thrown value with no name', async () => {
    /*
     * The name stripped rather than a bare string thrown: a string is what a
     * transport can genuinely reject with, but the lint rule forbids writing
     * one and it is right to. This reaches the same branch — a rejection whose
     * `name` the poller cannot read — without arguing with it.
     */
    const nameless = new Error('boom');
    Object.defineProperty(nameless, 'name', { value: undefined });

    const fake = client(() => {
      throw nameless;
    });

    const failures: { id: number; reason: string }[] = [];

    await sqsPublisher({
      client: fake.asClient,
      queueUrl: 'q',
      onFailure: (info) => failures.push(info),
    })([job(1)]);

    expect(failures).toEqual([{ id: 1, reason: 'unknown' }]);
  });
});

describe('the handler', () => {
  it('refuses to run without a queue to publish to', async () => {
    /*
     * **Refused rather than defaulted, and this is the expensive mistake.** A
     * poller pointed at nothing still claims rows: it fails to publish them,
     * increments every attempt counter, and after six passes the whole backlog
     * is set aside. A misconfiguration would consume the queue instead of
     * failing on the first invocation.
     */
    await withQueueUrl(undefined, async () => {
      await expect(handler()).rejects.toThrow(/EMBEDDING_QUEUE_URL/);
    });
  });

  it('treats an empty variable the same as a missing one', async () => {
    // An unset SST binding arrives as the empty string rather than as absent,
    // which is the shape this would actually have in a half-configured stage.
    await withQueueUrl('', async () => {
      await expect(handler()).rejects.toThrow(/EMBEDDING_QUEUE_URL/);
    });
  });

  it('drains the queue and reports what it moved', async () => {
    const runPass = passes([{ claimed: 2, published: 2 }]);
    const fake = client(allSucceed);

    await withQueueUrl('https://sqs.eu-west-1.amazonaws.com/1/embeddings', async () => {
      const result = await handler({}, {}, { runPass, client: fake.asClient });

      expect(result).toEqual({ passes: 1, claimed: 2, published: 2, failed: 0 });
    });
  });

  it('writes a failure as one structured line, carrying no free text', async () => {
    /*
     * The log is the only place a publish failure is recorded, and it is read
     * by a human during an outage — so it has to be greppable, and it has to
     * be safe. P0-56 governs what may be written down: the reason here is an
     * SQS code, never the provider's own message.
     */
    const lines: string[] = [];
    const fake = client((input) => ({
      Successful: [],
      Failed: input.Entries.map((entry) => ({ Id: entry.Id, Code: 'InternalError' })),
    }));

    const runPass = vi.fn(
      async (publish: (jobs: readonly OutboxJob[]) => Promise<readonly number[]>) => {
        await publish([job(5)]);
        return { claimed: 1, published: 0, failed: 1 };
      },
    );

    await withQueueUrl('https://sqs.eu-west-1.amazonaws.com/1/embeddings', async () => {
      await handler(
        {},
        {},
        {
          runPass: runPass as unknown as typeof import('@catalogorosso/db').runOutboxPass,
          client: fake.asClient,
          log: (line) => lines.push(line),
        },
      );
    });

    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { event: 'outbox.publish_failed', outboxId: 5, reason: 'InternalError' },
    ]);
  });
});
