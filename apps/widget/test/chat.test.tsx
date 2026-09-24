import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Analytics, WidgetEventType } from '../src/analytics.js';
import type { CartPort } from '../src/cart/port.js';
import { Chat, type Asker } from '../src/components/Chat.js';
import { it as COPY } from '../src/i18n/it.js';
import { ChatRefused } from '../src/send.js';
import type { StreamEvent } from '../src/sse.js';

/**
 * The chat, as a visitor uses it (P3-06).
 *
 * **Four cases the row names, and one it does not.** Deltas in order, cards on
 * a `recommendations` event, an error that offers a retry without discarding
 * anything, and an unmount that aborts the fetch. The fifth is the stream that
 * simply stops — no `done`, no error — which is what a dropped connection looks
 * like from here and would otherwise leave the panel streaming forever.
 */

afterEach(cleanup);

/** A stream that hands out exactly these events and then ends. */
const streamOf =
  (...events: readonly StreamEvent[]): Asker =>
  () => ({
    // eslint-disable-next-line @typescript-eslint/require-await -- an async iterable is the contract
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  });

/** A stream that yields, then waits for something that never comes. */
const hangingAfter =
  (...events: readonly StreamEvent[]): Asker =>
  () => ({
    async *[Symbol.asyncIterator]() {
      yield* events;
      await new Promise(() => undefined);
    },
  });

const WINE = {
  name: 'Barolo Bussia',
  producer: 'Cantina Rossi',
  vintage: 2016,
  priceCents: 4200,
  currency: 'EUR',
  imageUrl: null,
  productUrl: null,
  stockStatus: 'IN_STOCK',
  variantId: '45123456789',
} as const;

const ITEMS = [
  { productId: 'p1', reason: 'tannino deciso', confidence: 0.9, product: WINE },
  { productId: 'p2', reason: 'sorso morbido', confidence: 0.7, product: WINE },
];

const log = (): HTMLElement => screen.getByTestId('chat-log');
const box = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>(COPY.composerLabel);
const sendButton = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: COPY.send });
const form = (): HTMLFormElement => {
  const element = document.querySelector('form');

  if (element === null) throw new Error('The composer form is not on the page.');

  return element;
};

/**
 * Lets every queued microtask and every Preact rerender run.
 *
 * Needed before asserting that something is *absent*: `waitFor` stops at the
 * first moment its callback passes, which for a stream is several steps before
 * the loop has actually ended — so a negative assertion made there would pass
 * against code that goes on to render the thing.
 */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const askAbout = async (text = 'Che vino?'): Promise<void> => {
  fireEvent.input(box(), { target: { value: text } });

  await waitFor(() => {
    expect(sendButton().disabled).toBe(false);
  });

  fireEvent.submit(sendButton());
};

describe('reading an answer', () => {
  it('renders the deltas in order', async () => {
    render(
      <Chat
        ask={streamOf(
          { type: 'text', delta: 'Un ' },
          { type: 'text', delta: 'Barolo.' },
          { type: 'done' },
        )}
      />,
    );

    await askAbout();

    await waitFor(() => {
      expect(log().textContent).toContain('Un Barolo.');
    });
  });

  it('says nothing about a failure once the answer has finished', async () => {
    /*
     * A completed answer and a failed one are told apart by `done`, and a widget
     * that showed "connessione interrotta" under a finished reply would be
     * telling a visitor their working answer is broken.
     */
    render(<Chat ask={streamOf({ type: 'text', delta: 'Un Barolo.' }, { type: 'done' })} />);

    await askAbout();

    await waitFor(() => {
      expect(log().textContent).toContain('Un Barolo.');
    });
    await settle();

    expect(document.querySelector('.notice')).toBeNull();
    expect(screen.queryByRole('button', { name: COPY.retry })).toBeNull();
  });

  it('shows the visitor their own question', async () => {
    render(<Chat ask={streamOf({ type: 'done' })} />);

    await askAbout('Che vino con il brasato?');

    await waitFor(() => {
      expect(log().textContent).toContain('Che vino con il brasato?');
    });
  });

  it('renders a card per recommendation', async () => {
    render(<Chat ask={streamOf({ type: 'recommendations', items: ITEMS }, { type: 'done' })} />);

    await askAbout();

    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });

    expect(screen.getByText('tannino deciso')).toBeDefined();
  });

  it('announces the answer politely, without interrupting a screen reader', () => {
    render(<Chat ask={streamOf({ type: 'done' })} />);

    expect(log().getAttribute('aria-live')).toBe('polite');
    expect(log().getAttribute('role')).toBe('log');
  });

  it('says it is busy while the answer arrives, and stops when it ends', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ask: Asker = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', delta: 'Un ' } as const;
        await held;
        yield { type: 'done' } as const;
      },
    });

    render(<Chat ask={ask} />);
    await askAbout();

    await waitFor(() => {
      expect(log().getAttribute('aria-busy')).toBe('true');
    });

    release();

    await waitFor(() => {
      expect(log().getAttribute('aria-busy')).toBe('false');
    });
  });

  it('does not show an empty bubble before the first delta', async () => {
    render(<Chat ask={hangingAfter()} />);

    await askAbout('Che vino?');

    await waitFor(() => {
      expect(log().textContent).toContain('Che vino?');
    });

    /* The question, and nothing pretending to be an answer. */
    expect(log().querySelectorAll('.turn')).toHaveLength(1);
  });
});

describe('the composer', () => {
  it('refuses to send nothing', () => {
    render(<Chat ask={streamOf({ type: 'done' })} />);

    expect(sendButton().disabled).toBe(true);
  });

  it('refuses to send whitespace', () => {
    render(<Chat ask={streamOf({ type: 'done' })} />);

    fireEvent.input(box(), { target: { value: '   ' } });

    expect(sendButton().disabled).toBe(true);
  });

  it('sends nothing for a box full of spaces, however the form is submitted', () => {
    /*
     * The button is disabled, which stops a click. Pressing Return in the box
     * submits the form directly and reaches the handler regardless — so the
     * check has to be in the handler rather than only on the button.
     */
    const ask = vi.fn<Asker>(streamOf({ type: 'done' }));

    render(<Chat ask={ask} />);

    fireEvent.input(box(), { target: { value: '   ' } });
    fireEvent.submit(form());

    expect(ask).not.toHaveBeenCalled();
    expect(log().querySelectorAll('.turn')).toHaveLength(0);
  });

  it('clears the box so a visitor does not send the same question twice', async () => {
    render(<Chat ask={streamOf({ type: 'done' })} />);

    await askAbout();

    await waitFor(() => {
      expect(box().value).toBe('');
    });
  });

  it('is disabled while an answer is arriving', async () => {
    render(<Chat ask={hangingAfter({ type: 'text', delta: 'Un ' })} />);

    await askAbout();

    await waitFor(() => {
      expect(box().disabled).toBe(true);
    });
  });

  it('asks exactly once per submit, with the question as typed', async () => {
    const ask = vi.fn<Asker>(streamOf({ type: 'done' }));

    render(<Chat ask={ask} />);
    await askAbout();

    await waitFor(() => {
      expect(ask).toHaveBeenCalledTimes(1);
    });

    expect(ask.mock.calls[0]?.[0]).toBe('Che vino?');
  });
});

describe('when an answer stops early', () => {
  it('shows a retry and keeps what was already read', async () => {
    render(
      <Chat
        ask={streamOf(
          { type: 'text', delta: 'Un Barolo, ' },
          { type: 'error', code: 'provider_error' },
        )}
      />,
    );

    await askAbout();

    await waitFor(() => {
      expect(screen.getByText(COPY.errorProvider)).toBeDefined();
    });

    expect(screen.getByRole('button', { name: COPY.retry })).toBeDefined();
    /* The row's promise: the half-written answer is still on screen. */
    expect(log().textContent).toContain('Un Barolo,');
    expect(log().textContent).toContain('Che vino?');
  });

  it('asks the same question again when the retry is pressed', async () => {
    const ask = vi
      .fn<Asker>()
      .mockImplementationOnce(streamOf({ type: 'error', code: 'provider_error' }))
      .mockImplementationOnce(streamOf({ type: 'text', delta: 'Un Barolo.' }, { type: 'done' }));

    render(<Chat ask={ask} />);
    await askAbout('Che vino con il brasato?');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: COPY.retry })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: COPY.retry }));

    await waitFor(() => {
      expect(log().textContent).toContain('Un Barolo.');
    });

    expect(ask.mock.calls[1]?.[0]).toBe('Che vino con il brasato?');
    /* One question, asked twice: the visitor's words are not repeated on screen. */
    expect(log().querySelectorAll('.turn-visitor')).toHaveLength(1);
  });

  it('offers no retry for a month that is spent, and says nothing about billing', async () => {
    render(<Chat ask={streamOf({ type: 'error', code: 'quota_exceeded' })} />);

    await askAbout();

    await waitFor(() => {
      expect(screen.getByText(COPY.quota)).toBeDefined();
    });

    expect(screen.queryByRole('button', { name: COPY.retry })).toBeNull();
    expect(box().disabled).toBe(true);
    /* §1.3: no plan name, no counts, nothing a shopper could not be told. */
    expect(screen.getByText(COPY.quota).textContent).not.toMatch(/piano|limite|quota|\d/iu);
  });

  it('calls a refusal before the first byte what it is', async () => {
    const ask: Asker = () => {
      throw new ChatRefused(503);
    };

    render(<Chat ask={ask} />);
    await askAbout();

    await waitFor(() => {
      expect(screen.getByText(COPY.errorProvider)).toBeDefined();
    });
  });

  it('calls a connection that never opened a connection problem', async () => {
    const ask: Asker = () => {
      throw new TypeError('Failed to fetch');
    };

    render(<Chat ask={ask} />);
    await askAbout();

    await waitFor(() => {
      expect(screen.getByText(COPY.errorNetwork)).toBeDefined();
    });
  });

  it('does not sit streaming forever when the stream just stops', async () => {
    /*
     * No `done`, no `error` — the connection went away mid-answer. Left alone
     * the composer stays disabled and the panel looks like a slow model.
     */
    render(<Chat ask={streamOf({ type: 'text', delta: 'Un Bar' })} />);

    await askAbout();

    await waitFor(() => {
      expect(screen.getByText(COPY.errorNetwork)).toBeDefined();
    });

    expect(log().textContent).toContain('Un Bar');
    expect(box().disabled).toBe(false);
  });
});

describe('leaving', () => {
  it('aborts the fetch on unmount', async () => {
    const seen: AbortSignal[] = [];
    const ask: Asker = (_message, signal) => {
      seen.push(signal);

      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text', delta: 'Un ' } as const;
          await new Promise(() => undefined);
        },
      };
    };

    const view = render(<Chat ask={ask} />);

    await askAbout();
    await waitFor(() => {
      expect(seen).toHaveLength(1);
    });

    expect(seen[0]?.aborted).toBe(false);

    view.unmount();

    expect(seen[0]?.aborted).toBe(true);
  });

  it('does not show a failure for an answer the visitor abandoned', async () => {
    /*
     * An abort is us, not an outage. Rendering "connessione interrotta" into a
     * panel that is going away would also be a state update after unmount.
     */
    const ask: Asker = (_message, signal) => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', delta: 'Un ' } as const;

        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      },
    });

    const view = render(<Chat ask={ask} />);

    await askAbout();
    await waitFor(() => {
      expect(log().textContent).toContain('Un ');
    });

    view.unmount();
    await settle();

    expect(screen.queryByText(COPY.errorNetwork)).toBeNull();
  });
});

describe('when the winery stops serving mid-conversation', () => {
  /*
   * **A lapsed subscription must not look like a broken widget** (P3-21, §1.3).
   * The config said ACTIVE when the panel opened; the API is now answering
   * `unavailable`, and the state has to change under a panel already on screen
   * — to *disabled*, not to an error with a retry that can never succeed.
   */
  const lapsing: Asker = () => {
    throw new ChatRefused(403, undefined, 'unavailable');
  };

  it('renders the disabled notice rather than an error', async () => {
    render(<Chat ask={lapsing} />);
    await askAbout();

    await waitFor(() => {
      expect(screen.getByText(COPY.disabled)).toBeDefined();
    });
  });

  it('offers no retry, because there is nothing a retry could fix', async () => {
    render(<Chat ask={lapsing} />);
    await askAbout();

    await waitFor(() => {
      expect(screen.getByText(COPY.disabled)).toBeDefined();
    });

    expect(screen.queryByRole('button', { name: COPY.retry })).toBeNull();
  });

  it('takes no further questions', async () => {
    render(<Chat ask={lapsing} />);
    await askAbout();

    await waitFor(() => {
      expect(box().disabled).toBe(true);
    });
  });

  it('keeps the conversation on screen', async () => {
    /*
     * §6.8's blocked-mid-conversation case, verbatim: not an error state, and
     * not a reset that discards what the shopper was reading.
     */
    const ask = vi
      .fn<Asker>()
      .mockImplementationOnce(streamOf({ type: 'text', delta: 'Un Barolo.' }, { type: 'done' }))
      .mockImplementationOnce(lapsing);

    render(<Chat ask={ask} />);
    await askAbout('Che vino?');

    await waitFor(() => {
      expect(log().textContent).toContain('Un Barolo.');
    });

    await askAbout('E con il pesce?');

    await waitFor(() => {
      expect(screen.getByText(COPY.disabled)).toBeDefined();
    });

    expect(log().textContent).toContain('Un Barolo.');
    expect(log().textContent).toContain('Che vino?');
  });

  it('treats a refusal with any other code as an ordinary failure', async () => {
    /* A 403 for a mismatched origin is our problem to fix, not the seller's
     * billing, and it must not tell a shopper the shop is switched off. */
    const ask: Asker = () => {
      throw new ChatRefused(403, undefined, 'forbidden');
    };

    render(<Chat ask={ask} />);
    await askAbout();

    await waitFor(() => {
      expect(screen.getByText(COPY.errorProvider)).toBeDefined();
    });
  });
});

describe('what a conversation records', () => {
  /*
   * **The events are how we learn what the widget is worth** (P3-20, §Data
   * Model), and each has to be emitted where the thing actually happened — an
   * `ADD_TO_CART` recorded before the cart accepted the wine counts a sale that
   * did not happen.
   */
  const recording = () => {
    const seen: { type: WidgetEventType; productId?: string | undefined }[] = [];
    const analytics: Analytics = {
      record: (type, productId) => seen.push({ type, productId }),
      flush: () => undefined,
      stop: () => undefined,
    };

    return { analytics, types: () => seen.map((event) => event.type), seen };
  };

  const cartOf = (add: () => Promise<void>): CartPort => ({
    canAdd: true,
    needsVariantId: false,
    add,
    count: () => Promise.resolve(0),
  });

  it('records a message when one is sent', async () => {
    const { analytics, types } = recording();

    render(<Chat ask={streamOf({ type: 'done' })} analytics={analytics} />);
    await askAbout();

    await waitFor(() => {
      expect(types()).toContain('MESSAGE_SENT');
    });
  });

  it('records cards when cards arrive', async () => {
    const { analytics, types } = recording();

    render(
      <Chat
        ask={streamOf({ type: 'recommendations', items: ITEMS }, { type: 'done' })}
        analytics={analytics}
      />,
    );
    await askAbout();

    await waitFor(() => {
      expect(types()).toContain('RECOMMENDATION_SHOWN');
    });
  });

  it('records an answer with no cards as exactly that', async () => {
    /*
     * The one number that says the catalogue could not answer. Counting it as a
     * recommendation would hide the case worth acting on.
     */
    const { analytics, types } = recording();

    render(
      <Chat
        ask={streamOf({ type: 'recommendations', items: [] }, { type: 'done' })}
        analytics={analytics}
      />,
    );
    await askAbout();

    await waitFor(() => {
      expect(types()).toContain('ZERO_RESULTS');
    });

    expect(types()).not.toContain('RECOMMENDATION_SHOWN');
  });

  it('records an add only once the cart took it', async () => {
    const { analytics, seen } = recording();

    render(
      <Chat
        ask={streamOf({ type: 'recommendations', items: ITEMS }, { type: 'done' })}
        analytics={analytics}
        cart={cartOf(() => Promise.resolve())}
        cartUrl="/cart"
        navigate={() => undefined}
      />,
    );
    await askAbout();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: COPY.addToCart })).not.toHaveLength(0);
    });

    fireEvent.click(
      screen.getAllByRole('button', { name: COPY.addToCart })[0] as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(seen.map((event) => event.type)).toContain('ADD_TO_CART');
    });

    expect(seen.find((event) => event.type === 'ADD_TO_CART')?.productId).toBe('p1');
  });

  it('records no add when the cart refused', async () => {
    /* An attempt that failed is not a sale, and counting it would put a number
     * in front of a seller that their own order list contradicts. */
    const { analytics, types } = recording();

    render(
      <Chat
        ask={streamOf({ type: 'recommendations', items: ITEMS }, { type: 'done' })}
        analytics={analytics}
        cart={cartOf(() => Promise.reject(new Error('esaurito')))}
        cartUrl="/cart"
        navigate={() => undefined}
      />,
    );
    await askAbout();

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: COPY.addToCart })).not.toHaveLength(0);
    });

    fireEvent.click(
      screen.getAllByRole('button', { name: COPY.addToCart })[0] as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: COPY.addFailed })).not.toHaveLength(0);
    });

    expect(types()).not.toContain('ADD_TO_CART');
  });

  it('records the cart being opened', async () => {
    const { analytics, types } = recording();

    render(
      <Chat
        ask={streamOf({ type: 'done' })}
        analytics={analytics}
        cart={cartOf(() => Promise.resolve())}
        cartUrl="/cart"
        navigate={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: COPY.openCart }));

    await waitFor(() => {
      expect(types()).toContain('CART_OPEN');
    });
  });

  it('records a shopper following a link to the wine', async () => {
    const { analytics, seen } = recording();
    const linked = [
      {
        productId: 'p1',
        reason: 'tannino deciso',
        confidence: 0.9,
        product: { ...WINE, productUrl: 'https://shop.example/x' },
      },
    ];

    render(
      <Chat
        ask={streamOf({ type: 'recommendations', items: linked }, { type: 'done' })}
        analytics={analytics}
      />,
    );
    await askAbout();

    await waitFor(() => {
      expect(screen.getAllByRole('link')).not.toHaveLength(0);
    });

    fireEvent.click(screen.getAllByRole('link')[0] as HTMLAnchorElement);

    expect(seen.find((event) => event.type === 'PRODUCT_DETAIL_VIEW')?.productId).toBe('p1');
  });

  it('works with no analytics at all, because it must never be load-bearing', async () => {
    /* Every other test in this file runs without one, and that is the point:
     * the chat has to work when the events have nowhere to go. */
    render(<Chat ask={streamOf({ type: 'text', delta: 'Un Barolo.' }, { type: 'done' })} />);
    await askAbout();

    await waitFor(() => {
      expect(log().textContent).toContain('Un Barolo.');
    });
  });
});
