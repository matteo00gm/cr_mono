import { widgetEventInsert, type EventToRecord } from '@catalogorosso/db';
import { z } from 'zod';

/**
 * Reading an analytics batch (P6-01).
 *
 * **Each event on its own**: one malformed event is dropped and the rest are
 * kept, because analytics must never break the widget — and a batch rejected
 * whole for one bad entry is exactly that, one layer down. **Capped**, so a
 * script cannot write a thousand rows in one request: the widget sends twenty
 * at most (P3-20), and anything past `MAX_EVENTS` is not read.
 *
 * The token rides in the body rather than a header, because `sendBeacon` — the
 * only send that survives a page unload — cannot set one (P3-20).
 */

/** The most events read from one batch. The widget's own cap is twenty. */
export const MAX_EVENTS = 50;

/** How far back an event's own timestamp is believed: a batch flushed after a long idle is fine; a week is not. */
const OLDEST_MS = 24 * 60 * 60 * 1000;

/** How far ahead, for a visitor whose clock runs a little fast. */
const NEWEST_MS = 5 * 60 * 1000;

/** The event as the widget sends it: the table's type and product, and the moment it happened. */
const wireEvent = widgetEventInsert
  .pick({ type: true })
  .extend({ productId: z.uuid().optional(), at: z.number() });

const envelope = z.object({
  token: z.string().min(1).max(4_096),
  /** The per-tab id (P3-16): a UUID the widget made, or something that looks like one. */
  visitorId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/u),
  events: z.array(z.unknown()),
});

export interface ReadBatch {
  readonly token: string;
  readonly visitorId: string;
  readonly events: readonly EventToRecord[];
  /** Events dropped as malformed or past the cap. */
  readonly dropped: number;
}

/** The token alone, for the guard that verifies it before the handler reads the rest. */
export const tokenInBatch = (body: string): string | undefined => {
  const parsed = envelope.safeParse(parseJson(body));

  return parsed.success ? parsed.data.token : undefined;
};

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * The batch, its events checked one by one and stamped within reason — or
 * `undefined` when the envelope itself is not one.
 */
export const readEventBatch = (body: string, now: Date = new Date()): ReadBatch | undefined => {
  const parsed = envelope.safeParse(parseJson(body));

  if (!parsed.success) return undefined;

  const considered = parsed.data.events.slice(0, MAX_EVENTS);
  const events: EventToRecord[] = [];

  for (const candidate of considered) {
    const event = wireEvent.safeParse(candidate);

    if (!event.success) continue;

    /* Stamped when it happened (P3-20), unless the claim is not believable. */
    const at = event.data.at;
    const believable = at >= now.getTime() - OLDEST_MS && at <= now.getTime() + NEWEST_MS;

    events.push({
      type: event.data.type,
      productId: event.data.productId ?? null,
      at: believable ? new Date(at) : now,
    });
  }

  return {
    token: parsed.data.token,
    visitorId: parsed.data.visitorId,
    events,
    dropped: parsed.data.events.length - events.length,
  };
};
