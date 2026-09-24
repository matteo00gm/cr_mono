/**
 * What a visitor did, batched and thrown at the wall (P3-20, §Data Model).
 *
 * **Fire and forget, and that is a rule rather than an optimisation.** Nothing
 * here may block a send, surface an error to a shopper, or reject into the
 * page. An analytics endpoint having a bad afternoon must be invisible on a
 * seller's storefront — the events are how we learn what the widget is worth,
 * and a shop that broke because of them would be worth nothing.
 *
 * **Flushed on `pagehide` with `sendBeacon`.** A `fetch` on unload is not
 * reliable: the browser is entitled to cancel it the moment the page goes, and
 * the events it cancels are the interesting ones — the visitor who read three
 * cards and left. `sendBeacon` is queued by the browser and survives the
 * navigation, which is the whole reason it exists.
 *
 * **The ingest endpoint is P6-01's.** Until it lands these are 404s, which is
 * exactly what "a failing endpoint does not surface an error" means and is
 * tested as such.
 */

/** The seven the schema names (P0-29). A type outside this list is a migration. */
export const WIDGET_EVENTS = [
  'WIDGET_OPEN',
  'MESSAGE_SENT',
  'RECOMMENDATION_SHOWN',
  'PRODUCT_DETAIL_VIEW',
  'ADD_TO_CART',
  'CART_OPEN',
  'ZERO_RESULTS',
] as const;

export type WidgetEventType = (typeof WIDGET_EVENTS)[number];

/** Where P6-01's ingest will answer, relative to the API origin the loader captured. */
export const EVENTS_PATH = '/v1/widget/events';

/**
 * Long enough to collect a burst, short enough to survive a visitor leaving.
 *
 * Opening the panel emits one event and the first answer emits two more within
 * a second or so; a debounce shorter than that sends three requests where one
 * would do, and a longer one loses them to a `pagehide` that arrives first.
 */
export const FLUSH_DEBOUNCE_MS = 2000;

/**
 * How many events are held before a flush happens regardless.
 *
 * A shopper who works through twenty cards should not be one lost `pagehide`
 * away from us knowing nothing about it.
 */
export const MAX_BATCH = 20;

export interface WidgetEvent {
  readonly type: WidgetEventType;
  /** The product a card-level event is about, when there is one. */
  readonly productId?: string | undefined;
  /** Milliseconds since the epoch, taken when the thing happened rather than when it is sent. */
  readonly at: number;
}

export interface Analytics {
  /** Records one event. Never throws, never returns a promise worth awaiting. */
  readonly record: (type: WidgetEventType, productId?: string) => void;
  /** Sends what is held now. Called by the debounce, the cap, and `pagehide`. */
  readonly flush: () => void;
  /** Stops listening. A panel going away must not leave a `pagehide` handler behind. */
  readonly stop: () => void;
}

export interface AnalyticsOptions {
  readonly api: string;
  readonly key: string;
  /** The anonymous per-tab id (P3-16), so a session's events group without naming anybody. */
  readonly visitorId: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** Injected so a test can assert the unload path without unloading anything. */
  readonly sendBeacon?: ((url: string, body: BodyInit) => boolean) | undefined;
  readonly now?: (() => number) | undefined;
  /** Where `pagehide` is listened for. Injected for the same reason. */
  readonly target?: EventTarget | undefined;
}

/**
 * Collects events and sends them in batches.
 *
 * **Every path is wrapped.** `sendBeacon` throws in a sandboxed frame,
 * `fetch` rejects offline, `JSON.stringify` throws on a cycle somebody
 * introduces later. None of those is a reason for a shopper to see anything.
 */
export const createAnalytics = ({
  api,
  key,
  visitorId,
  fetch: fetch_ = globalThis.fetch,
  sendBeacon = (url, body) => globalThis.navigator.sendBeacon(url, body),
  now = () => Date.now(),
  target = globalThis,
}: AnalyticsOptions): Analytics => {
  const url = `${api}${EVENTS_PATH}?key=${encodeURIComponent(key)}`;

  let held: WidgetEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);

    timer = undefined;
  };

  /**
   * `sendBeacon` when the page may be going, `fetch` otherwise.
   *
   * Beacon is queued by the browser and survives a navigation; it is also
   * limited to 64 KB and returns `false` when it refuses, which is why the
   * result is read rather than assumed.
   */
  const send = (events: readonly WidgetEvent[], unloading: boolean): void => {
    let body: string;

    try {
      body = JSON.stringify({ visitorId, events });
    } catch {
      return;
    }

    if (unloading) {
      try {
        if (sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
      } catch {
        /* A sandboxed frame throws on the getter. Fall through and try `fetch`,
         * which will probably be cancelled — but probably is better than never. */
      }
    }

    try {
      /*
       * `keepalive` for the same reason as the beacon, and `credentials: 'omit'`
       * for the same reason as every other call to this surface (P2-08).
       */
      void fetch_(url, {
        method: 'POST',
        credentials: 'omit',
        keepalive: unloading,
        headers: { 'content-type': 'application/json' },
        body,
      }).catch(() => undefined);
    } catch {
      /* Nothing left to try, and nothing a shopper could do about it. */
    }
  };

  const flush = (unloading = false): void => {
    clear();

    if (held.length === 0) return;

    const batch = held;

    held = [];
    send(batch, unloading);
  };

  const onPagehide = (): void => {
    flush(true);
  };

  target.addEventListener('pagehide', onPagehide);

  return {
    record: (type, productId) => {
      held.push({ type, at: now(), ...(productId === undefined ? {} : { productId }) });

      if (held.length >= MAX_BATCH) {
        flush();

        return;
      }

      clear();
      timer = setTimeout(() => {
        flush();
      }, FLUSH_DEBOUNCE_MS);
    },

    flush: () => {
      flush();
    },

    stop: () => {
      clear();
      target.removeEventListener('pagehide', onPagehide);
    },
  };
};
