import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Chat, COPY, type Asker } from '../src/components/Chat.js';
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

const ITEMS = [
  { productId: 'p1', reason: 'tannino deciso', confidence: 0.9 },
  { productId: 'p2', reason: 'sorso morbido', confidence: 0.7 },
];

const log = (): HTMLElement => screen.getByTestId('chat-log');
const box = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>(COPY.label);
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
      expect(screen.getByText(COPY.provider)).toBeDefined();
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
      throw new ChatRefused(429);
    };

    render(<Chat ask={ask} />);
    await askAbout();

    await waitFor(() => {
      expect(screen.getByText(COPY.provider)).toBeDefined();
    });
  });

  it('calls a connection that never opened a connection problem', async () => {
    const ask: Asker = () => {
      throw new TypeError('Failed to fetch');
    };

    render(<Chat ask={ask} />);
    await askAbout();

    await waitFor(() => {
      expect(screen.getByText(COPY.network)).toBeDefined();
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
      expect(screen.getByText(COPY.network)).toBeDefined();
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

    expect(screen.queryByText(COPY.network)).toBeNull();
  });
});
