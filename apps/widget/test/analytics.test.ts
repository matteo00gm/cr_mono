import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAnalytics,
  EVENTS_PATH,
  FLUSH_DEBOUNCE_MS,
  MAX_BATCH,
  WIDGET_EVENTS,
  type Analytics,
} from '../src/analytics.js';

/**
 * What a visitor did (P3-20, §Data Model).
 *
 * **The rule this file exists to hold is that nothing here can break a shop.**
 * An endpoint that 404s, a `sendBeacon` that throws in a sandboxed frame, a
 * network that is not there — every one of those has to be invisible on a
 * seller's storefront. The events are how we learn what the widget is worth,
 * and a shop that broke because of them would be worth nothing.
 *
 * The second is the unload path. A `fetch` on unload is cancellable, and the
 * events it loses are the interesting ones: the visitor who read three cards
 * and left.
 */

const API = 'https://api.example';
const KEY = 'pk_test_abc';
const VISITOR = 'visitor-1';

let sent: { url: string; body: string }[];
let beaconed: { url: string; body: unknown }[];
let target: EventTarget;

const bodyOf = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '';

const build = (overrides: Partial<Parameters<typeof createAnalytics>[0]> = {}): Analytics =>
  createAnalytics({
    api: API,
    key: KEY,
    visitorId: VISITOR,
    target,
    fetch: vi.fn<typeof globalThis.fetch>((input, init) => {
      /* Always a string here; `RequestInfo` is wider than what we ever pass. */
      sent.push({ url: input as string, body: bodyOf(init) });

      return Promise.resolve(new Response('', { status: 202 }));
    }),
    sendBeacon: (url, body) => {
      beaconed.push({ url, body });

      return true;
    },
    ...overrides,
  });

/** What was posted, parsed, whichever transport carried it. */
const eventsIn = (body: string): { type: string; productId?: string }[] =>
  (JSON.parse(body) as { events: { type: string; productId?: string }[] }).events;

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  beaconed = [];
  target = new EventTarget();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('collecting', () => {
  it('sends nothing until the debounce elapses', () => {
    /* Opening the panel emits one event and the first answer emits two more
     * within a second; sending each on its own is three requests for one. */
    const analytics = build();

    analytics.record('WIDGET_OPEN');

    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);

    expect(sent).toHaveLength(1);
  });

  it('batches what arrived inside the window into one request', () => {
    const analytics = build();

    analytics.record('WIDGET_OPEN');
    analytics.record('MESSAGE_SENT');
    analytics.record('RECOMMENDATION_SHOWN');

    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS);

    expect(sent).toHaveLength(1);
    expect(eventsIn(sent[0]?.body ?? '').map((event) => event.type)).toEqual([
      'WIDGET_OPEN',
      'MESSAGE_SENT',
      'RECOMMENDATION_SHOWN',
    ]);
  });

  it('restarts the window on each event, so a burst is one request', () => {
    const analytics = build();

    analytics.record('WIDGET_OPEN');
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 100);
    analytics.record('MESSAGE_SENT');
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 100);

    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(100);

    expect(sent).toHaveLength(1);
  });

  it('sends without waiting once the batch is full', () => {
    /* A shopper working through twenty cards should not be one lost `pagehide`
     * away from us knowing nothing about it. */
    const analytics = build();

    for (let index = 0; index < MAX_BATCH; index += 1) analytics.record('PRODUCT_DETAIL_VIEW');

    expect(sent).toHaveLength(1);
    expect(eventsIn(sent[0]?.body ?? '')).toHaveLength(MAX_BATCH);
  });

  it('sends nothing at all when nothing happened', () => {
    build().flush();

    expect(sent).toHaveLength(0);
    expect(beaconed).toHaveLength(0);
  });

  it('empties what it sent, so a second flush does not send it twice', () => {
    const analytics = build();

    analytics.record('WIDGET_OPEN');
    analytics.flush();
    analytics.flush();

    expect(sent).toHaveLength(1);
  });
});

describe('what a batch carries', () => {
  it('names the endpoint and the key', () => {
    const analytics = build();

    analytics.record('WIDGET_OPEN');
    analytics.flush();

    expect(sent[0]?.url).toBe(`${API}${EVENTS_PATH}?key=${KEY}`);
  });

  it('carries the anonymous id, so a session groups without naming anybody', () => {
    // The per-tab id (P3-16). Not the token, and not a person.
    const analytics = build();

    analytics.record('WIDGET_OPEN');
    analytics.flush();

    expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({ visitorId: VISITOR });
  });

  it('carries the product a card event is about', () => {
    const analytics = build();

    analytics.record('ADD_TO_CART', 'p1');
    analytics.flush();

    expect(eventsIn(sent[0]?.body ?? '')[0]).toMatchObject({
      type: 'ADD_TO_CART',
      productId: 'p1',
    });
  });

  it('omits the product entirely when there is not one', () => {
    const analytics = build();

    analytics.record('WIDGET_OPEN');
    analytics.flush();

    expect(eventsIn(sent[0]?.body ?? '')[0]).not.toHaveProperty('productId');
  });

  it('stamps each event when it happened, not when it was sent', () => {
    /* A batch flushed on unload can be seconds after the click, and a timestamp
     * taken at send time would put every event of a visit at the same instant. */
    let clock = 1000;
    const analytics = build({ now: () => clock });

    analytics.record('WIDGET_OPEN');
    clock = 5000;
    analytics.record('MESSAGE_SENT');
    analytics.flush();

    const events = eventsIn(sent[0]?.body ?? '') as unknown as { at: number }[];

    expect(events[0]?.at).toBe(1000);
    expect(events[1]?.at).toBe(5000);
  });

  it('sends no cookies, because this surface refuses them', () => {
    const fetch_ = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('', { status: 202 })),
    );
    const analytics = build({ fetch: fetch_ });

    analytics.record('WIDGET_OPEN');
    analytics.flush();

    expect(fetch_.mock.calls[0]?.[1]?.credentials).toBe('omit');
  });
});

describe('a visitor leaving the page', () => {
  it('flushes on pagehide', () => {
    const analytics = build();

    analytics.record('WIDGET_OPEN');
    target.dispatchEvent(new Event('pagehide'));

    expect(beaconed).toHaveLength(1);
  });

  it('uses sendBeacon, because a fetch on unload is cancellable', () => {
    /*
     * The events a cancelled request loses are the interesting ones: the
     * visitor who read three cards and left without asking anything.
     */
    const analytics = build();

    analytics.record('PRODUCT_DETAIL_VIEW', 'p1');
    target.dispatchEvent(new Event('pagehide'));

    expect(beaconed).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('falls back to fetch when the beacon refuses', () => {
    /* `sendBeacon` returns false over 64 KB, and a large batch is exactly when
     * losing it would matter most. */
    const analytics = build({ sendBeacon: () => false });

    analytics.record('WIDGET_OPEN');
    target.dispatchEvent(new Event('pagehide'));

    expect(sent).toHaveLength(1);
  });

  it('falls back when the beacon throws, which a sandboxed frame does', () => {
    const analytics = build({
      sendBeacon: () => {
        throw new Error('The operation is insecure.');
      },
    });

    analytics.record('WIDGET_OPEN');

    expect(() => {
      target.dispatchEvent(new Event('pagehide'));
    }).not.toThrow();
    expect(sent).toHaveLength(1);
  });

  it('sends nothing on pagehide when nothing is held', () => {
    build();

    target.dispatchEvent(new Event('pagehide'));

    expect(beaconed).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('stops listening when the panel goes, leaving no handler behind', () => {
    const analytics = build();

    analytics.record('WIDGET_OPEN');
    analytics.stop();
    target.dispatchEvent(new Event('pagehide'));

    expect(beaconed).toHaveLength(0);
  });

  it('cancels its timer on stop, so nothing wakes the page afterwards', () => {
    const analytics = build();

    analytics.record('WIDGET_OPEN');
    analytics.stop();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('an endpoint having a bad afternoon', () => {
  /*
   * **The rule, and it is a rule.** P6-01's ingest does not exist yet, so every
   * one of these is a 404 today — which is exactly the case this has to survive.
   */
  it('does not throw when the endpoint refuses', () => {
    const analytics = build({
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response('', { status: 404 })),
      ),
    });

    analytics.record('WIDGET_OPEN');

    expect(() => {
      analytics.flush();
    }).not.toThrow();
  });

  it('does not reject into the page when the network is gone', async () => {
    /*
     * **Caught by listening for it**, because that is the only way this failure
     * is visible: an unhandled rejection surfaces in a seller's own error
     * tracker, with our name on the stack, on a page we do not own.
     */
    const unhandled: unknown[] = [];
    const onEvent = (event: Event): void => {
      event.preventDefault();
      unhandled.push(event);
    };
    /*
     * Both hooks. The promise is created in the Node realm, so `process` is
     * where the report actually lands; the DOM event is listened for as well
     * because which one fires depends on the environment, and a test that
     * watched only the wrong one would pass on a real leak.
     */
    const onProcess = (reason: unknown): void => {
      unhandled.push(reason);
    };

    globalThis.addEventListener('unhandledrejection', onEvent);
    process.on('unhandledRejection', onProcess);

    try {
      /*
       * **A plain function, not a `vi.fn`.** A mock attaches its own handler to
       * whatever it returns in order to record the result, which *handles* the
       * rejection — so this test passed against a version with no `.catch` at
       * all, and the thing it exists to prove was unobservable.
       */
      const analytics = build({
        fetch: (() =>
          Promise.reject(new TypeError('offline'))) as unknown as typeof globalThis.fetch,
      });

      analytics.record('WIDGET_OPEN');
      analytics.flush();

      /*
       * Real timers, and a generous wait: Node reports an unhandled rejection
       * once the microtask queue drains, and under Vitest's instrumentation
       * that is later than the next tick.
       */
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(unhandled).toHaveLength(0);
    } finally {
      globalThis.removeEventListener('unhandledrejection', onEvent);
      process.off('unhandledRejection', onProcess);
    }
  });

  it('does not throw when fetch itself throws synchronously', () => {
    const analytics = build({
      fetch: (() => {
        throw new Error('blocked by an extension');
      }) as unknown as typeof globalThis.fetch,
    });

    analytics.record('WIDGET_OPEN');

    expect(() => {
      analytics.flush();
    }).not.toThrow();
  });

  it('drops a batch it cannot serialise rather than throwing', () => {
    const analytics = build();
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    analytics.record('WIDGET_OPEN', cyclic as unknown as string);

    expect(() => {
      analytics.flush();
    }).not.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe('the seven types', () => {
  it('are the seven the schema names', () => {
    // A type outside this list is a migration, not a code change (P0-29).
    expect([...WIDGET_EVENTS]).toEqual([
      'WIDGET_OPEN',
      'MESSAGE_SENT',
      'RECOMMENDATION_SHOWN',
      'PRODUCT_DETAIL_VIEW',
      'ADD_TO_CART',
      'CART_OPEN',
      'ZERO_RESULTS',
    ]);
  });
});
