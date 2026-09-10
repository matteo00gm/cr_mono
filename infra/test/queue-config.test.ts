import { describe, expect, it } from 'vitest';

import {
  assertConnectionBudget,
  assertVisibilityCoversHandler,
  BATCH_SIZE,
  budgetedConnections,
  CONNECTIONS,
  DLQ_RETENTION_SECONDS,
  MAX_RECEIVE_COUNT,
  VISIBILITY_MULTIPLE,
  VISIBILITY_TIMEOUT_SECONDS,
  WORKER_TIMEOUT_SECONDS,
} from '../queue-config.js';

/**
 * The embedding pipeline's numbers (P1-32).
 *
 * **Every figure here fails silently when it is wrong**, which is why they were
 * pulled out of `queue.ts` at all: that module constructs SST resources at
 * import time and cannot be loaded outside a deploy, so nothing could check
 * them. A visibility timeout under the handler's budget produces duplicate
 * work and no error; a concurrency raised on its own exhausts
 * `max_connections` while the symptom reads as an application fault.
 *
 * What cannot be asserted here is that `queue.ts` actually *uses* them — for
 * that the module would have to be loadable. The two assertions it calls at
 * synth time are the substitute, and they run on every `sst deploy`.
 */

describe('the visibility timeout', () => {
  it('covers the handler several times over', () => {
    /*
     * **The classic SQS misconfiguration, and it produces no error anywhere.**
     * A visibility timeout shorter than the handler means SQS redelivers a
     * message that is still being processed: two workers embed the same wine,
     * both pay Bedrock, and the second overwrites the first. The only symptom
     * is on the bill.
     */
    expect(VISIBILITY_TIMEOUT_SECONDS).toBe(WORKER_TIMEOUT_SECONDS * VISIBILITY_MULTIPLE);
    expect(VISIBILITY_MULTIPLE).toBeGreaterThanOrEqual(6);
  });

  it('is asserted rather than assumed', () => {
    // The guard has to be able to fail, so it is driven with a value that
    // should trip it. Somebody shortening the window to make redelivery faster
    // is the realistic way this changes.
    expect(() => assertVisibilityCoversHandler()).not.toThrow();
    expect(() => assertVisibilityCoversHandler(60, 300)).toThrow(/redeliver/i);
  });

  it('leaves room for a cold start on top of the handler', () => {
    /*
     * The bare minimum would be 1×. The extra is not padding: this function
     * attaches an ENI on a cold start, and the clock SQS is watching starts
     * before any of that.
     */
    expect(VISIBILITY_TIMEOUT_SECONDS - WORKER_TIMEOUT_SECONDS).toBeGreaterThan(
      WORKER_TIMEOUT_SECONDS,
    );
  });
});

describe('the connection budget', () => {
  it('leaves half the instance for everything that is not a request', () => {
    /*
     * The other half is not slack. It is migrations, the sweep jobs, and a
     * human with `psql` during the incident that raising the concurrency
     * caused — which is exactly when the connections are least available.
     */
    expect(budgetedConnections()).toBeLessThanOrEqual(CONNECTIONS.instanceMax / 2);
  });

  it('refuses a concurrency raised on its own', () => {
    /*
     * **The realistic mistake.** Nobody raises `max_connections`; somebody
     * raises the worker's concurrency because the queue is backing up, and the
     * database falls over first with a symptom that reads as an application
     * fault.
     */
    expect(() => assertConnectionBudget()).not.toThrow();
    expect(() => assertConnectionBudget({ ...CONNECTIONS, workerConcurrency: 60 })).toThrow(
      /instance class/i,
    );
  });

  it('counts two connections per container, not one', () => {
    // A pool of one would be a serialised function. The figure has to match
    // what `createDbClient` is configured with, or the budget is fiction.
    expect(CONNECTIONS.perContainer).toBe(2);
  });
});

describe('the queue settings', () => {
  it('sends a message to the DLQ after three deliveries, not one', () => {
    /*
     * The worker already retries inside a single attempt — Titan's ladder is
     * four calls — so three deliveries is up to twelve provider calls before a
     * wine is set aside. One would send every transient throttle to the DLQ.
     */
    expect(MAX_RECEIVE_COUNT).toBe(3);
  });

  it('holds a dead-lettered message for two weeks', () => {
    /*
     * The queue default is four days, and the realistic gap between a Friday
     * incident and somebody investigating is longer than that. A DLQ that
     * expires its own contents is a DLQ that loses the evidence.
     */
    expect(DLQ_RETENTION_SECONDS).toBe(14 * 24 * 60 * 60);
  });

  it('takes ten messages at a time, which is the API maximum', () => {
    expect(BATCH_SIZE).toBe(10);
  });
});
