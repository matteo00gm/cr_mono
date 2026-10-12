import {
  ApiError,
  type RagAnswerResponse,
  type RagSimulationResponse,
} from '@catalogorosso/api-client';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ANSWER_BUTTON,
  ENDED,
  EXCLUDED,
  NOTHING_FOUND,
  SandboxScreen,
} from '../src/features/sandbox/SandboxScreen.js';
import { fakeClient, type Route } from './support/client.js';

/**
 * Prova il sommelier (P2-37b): the free search, and the answer that is asked
 * for on purpose because it is billed.
 */

afterEach(cleanup);

const SIMULATE = 'POST /v1/dashboard/rag/simulate';
const ANSWER = 'POST /v1/dashboard/rag/answer';
const QUESTION = 'qualcosa per una bistecca';

const candidate = (
  over: Partial<RagSimulationResponse['candidates'][number]>,
): RagSimulationResponse['candidates'][number] => ({
  productId: 'p1',
  name: 'Barolo Monfortino',
  vectorRank: 1,
  vectorScore: 0.8,
  lexicalRank: 1,
  rrfScore: 0.03,
  completeness: { score: 80, missing: [] },
  stockStatus: 'IN_STOCK',
  priceCents: 18_500,
  included: true,
  excludedBy: null,
  ...over,
});

const FOUND: RagSimulationResponse = {
  candidates: [
    candidate({}),
    candidate({ productId: 'p2', name: 'Chianti Classico', included: false, excludedBy: 'stock' }),
    candidate({ productId: 'p3', name: 'Amarone', included: false, excludedBy: 'cap' }),
  ],
  preCapCount: 2,
  zeroResultKind: null,
  timings: { embedMs: 1, searchMs: 2 },
  systemPromptHash: 'deadbeef',
};

const SAID: RagAnswerResponse = {
  reply: 'Con la bistecca, un Barolo.',
  recommendations: [
    { productId: 'p1', name: 'Barolo Monfortino', reason: 'Regge la carne.', confidence: 0.9 },
  ],
  outcome: 'ok',
};

const mount = (routes: { simulate?: Route; answer?: Route } = {}) => {
  const { client, request } = fakeClient({
    [SIMULATE]: routes.simulate ?? (() => Promise.resolve(FOUND)),
    [ANSWER]: routes.answer ?? (() => Promise.resolve(SAID)),
  });

  render(<SandboxScreen client={client} />);

  const calls = (endpoint: string) => request.mock.calls.filter(([called]) => called === endpoint);

  return { request, calls };
};

const type = (value: string): void => {
  fireEvent.input(screen.getByLabelText('Domanda'), { target: { value } });
};

const searchButton = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Cerca nel catalogo' });
const answerButton = () => screen.getByRole<HTMLButtonElement>('button', { name: ANSWER_BUTTON });

describe('searching the catalogue', () => {
  it('asks the free simulation, and never for an answer', async () => {
    const { calls } = mount();

    type(`  ${QUESTION} `);
    fireEvent.click(searchButton());

    const list = within(await screen.findByRole('region', { name: 'Cosa ha trovato il catalogo' }));

    expect(calls(SIMULATE)).toEqual([[SIMULATE, { body: { query: QUESTION } }]]);
    /* Off unless asked: a search, however it ends, is not a request for a billed answer. */
    expect(calls(ANSWER)).toEqual([]);
    expect(list.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Barolo Monfortino — proposto al sommelier',
      `Chianti Classico — ${EXCLUDED.stock}`,
      `Amarone — ${EXCLUDED.cap}`,
    ]);
  });

  it('is what Enter does: the key a seller presses without thinking never spends a message', async () => {
    const { calls } = mount();

    type(QUESTION);
    /* Dispatched on the field and bubbling to the form, as the key does. */
    fireEvent.submit(screen.getByLabelText('Domanda'));

    await screen.findByRole('region', { name: 'Cosa ha trovato il catalogo' });

    expect(calls(SIMULATE)).toHaveLength(1);
    expect(calls(ANSWER)).toEqual([]);
  });

  it('does nothing on Enter with nothing typed', () => {
    const { request } = mount();

    type('   ');
    fireEvent.submit(screen.getByLabelText('Domanda'));

    expect(request).not.toHaveBeenCalled();
  });

  it('does not start a search on Enter while an answer is being written', async () => {
    const { calls } = mount({ answer: () => new Promise(() => undefined) });

    type(QUESTION);
    fireEvent.click(answerButton());
    await screen.findByRole('status');

    fireEvent.submit(screen.getByLabelText('Domanda'));

    expect(calls(SIMULATE)).toEqual([]);
    expect(calls(ANSWER)).toHaveLength(1);
  });

  it.each(Object.entries(NOTHING_FOUND))(
    'says why there is nothing to propose: %s',
    async (zeroResultKind, sentence) => {
      mount({
        simulate: () =>
          Promise.resolve({ ...FOUND, candidates: [], preCapCount: 0, zeroResultKind }),
      });

      type(QUESTION);
      fireEvent.click(searchButton());

      expect(await screen.findByText(sentence)).toBeTruthy();
    },
  );

  it('says so in Italian when the search itself fails', async () => {
    mount({ simulate: () => Promise.reject(new TypeError('Failed to fetch')) });

    type(QUESTION);
    fireEvent.click(searchButton());

    expect((await screen.findByRole('alert')).textContent).toBe(
      'La ricerca non è riuscita. Riprova fra un momento.',
    );
  });
});

describe('asking for the answer', () => {
  it('says on the button that it counts as a message', () => {
    mount();

    expect(ANSWER_BUTTON).toMatch(/conta come 1 messaggio/u);
    expect(answerButton()).toBeTruthy();
  });

  it('asks once, for the question as typed, and shows the reply with the wines under it', async () => {
    const { calls } = mount();

    type(QUESTION);
    fireEvent.click(answerButton());

    const said = within(await screen.findByRole('region', { name: 'La risposta del sommelier' }));

    expect(calls(ANSWER)).toEqual([[ANSWER, { body: { query: QUESTION } }]]);
    expect(said.getByText('Con la bistecca, un Barolo.')).toBeTruthy();
    expect(said.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Barolo Monfortino — Regge la carne.',
    ]);
  });

  it('asks for one at a time: a second click while it is being written is not a second message', async () => {
    let finish: (answer: RagAnswerResponse) => void = () => undefined;
    const { calls } = mount({
      answer: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });

    type(QUESTION);
    fireEvent.click(answerButton());
    fireEvent.click(answerButton());

    expect((await screen.findByRole('status')).textContent).toBe('Il sommelier sta scrivendo…');
    expect(answerButton().disabled).toBe(true);
    expect(searchButton().disabled).toBe(true);

    finish(SAID);

    await screen.findByRole('region', { name: 'La risposta del sommelier' });
    expect(calls(ANSWER)).toHaveLength(1);
    expect(answerButton().disabled).toBe(false);
  });

  it('cannot be asked with nothing typed', () => {
    const { request } = mount();

    type('   ');

    expect(answerButton().disabled).toBe(true);
    expect(searchButton().disabled).toBe(true);

    fireEvent.click(answerButton());

    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'conflict', 'Questa cantina ha usato tutti i messaggi del mese.'],
    [429, 'rate_limited', 'Qui puoi chiedere fino a 10 risposte al minuto.'],
  ])('says what the API said when it refuses (%i)', async (status, code, message) => {
    mount({ answer: () => Promise.reject(new ApiError(status, code, message, 'r1')) });

    type(QUESTION);
    fireEvent.click(answerButton());

    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.queryByRole('region', { name: 'La risposta del sommelier' })).toBeNull();
  });

  it('says so in Italian when no answer comes back at all', async () => {
    mount({ answer: () => Promise.reject(new TypeError('Failed to fetch')) });

    type(QUESTION);
    fireEvent.click(answerButton());

    expect((await screen.findByRole('alert')).textContent).toBe(
      'La risposta non è arrivata. Riprova fra un momento.',
    );
  });

  it.each(
    Object.entries(ENDED).filter(
      (entry): entry is [RagAnswerResponse['outcome'], string] => entry[1] !== undefined,
    ),
  )('explains a turn that ended as %s', async (outcome, sentence) => {
    mount({
      answer: () => Promise.resolve({ reply: 'Non saprei.', recommendations: [], outcome }),
    });

    type(QUESTION);
    fireEvent.click(answerButton());

    const said = within(await screen.findByRole('region', { name: 'La risposta del sommelier' }));

    expect(said.getByText(sentence)).toBeTruthy();
    expect(said.queryByRole('list')).toBeNull();
  });

  it('shows a reply as text, whatever a model wrote in it', async () => {
    mount({
      answer: () =>
        Promise.resolve({ ...SAID, reply: '<img src=x onerror=alert(1)>', recommendations: [] }),
    });

    type(QUESTION);
    fireEvent.click(answerButton());

    const said = await screen.findByRole('region', { name: 'La risposta del sommelier' });

    expect(said.querySelector('img')).toBeNull();
    expect(said.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('a question that changed', () => {
  it('takes what was on screen with it: an old answer is not shown under a new question', async () => {
    mount();

    type(QUESTION);
    fireEvent.click(searchButton());
    await screen.findByRole('region', { name: 'Cosa ha trovato il catalogo' });
    fireEvent.click(answerButton());
    await screen.findByRole('region', { name: 'La risposta del sommelier' });

    type('e con il pesce?');

    expect(screen.queryByRole('region', { name: 'Cosa ha trovato il catalogo' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'La risposta del sommelier' })).toBeNull();
  });

  it('drops an answer that arrives after the question it was for has gone', async () => {
    let finish: (answer: RagAnswerResponse) => void = () => undefined;

    mount({
      answer: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });

    type(QUESTION);
    fireEvent.click(answerButton());
    await screen.findByRole('status');

    type('e con il pesce?');
    finish(SAID);

    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
    expect(screen.queryByRole('region', { name: 'La risposta del sommelier' })).toBeNull();
  });
});
