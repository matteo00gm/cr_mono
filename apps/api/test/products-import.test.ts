import { randomUUID } from 'node:crypto';

import { IMPORT_TIME_BUDGET_MS, MAX_IMPORT_BODY_BYTES, MAX_IMPORT_ROWS } from '@catalogorosso/core';

import { productsImportedResponse } from '@catalogorosso/api-client';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import type { ImportRunClaim } from '@catalogorosso/db';

import {
  countImportOutcomes,
  type ClaimImportCommand,
  type CompleteImportCommand,
  type ImportProductsCommand,
  type ImportProductsResult,
  type ProductsPort,
} from '../src/products.js';
import { logger } from '../src/middleware/logger.js';
import { oneMembership, signedIn } from './support/auth.js';
import { productsPort } from './support/products.js';

/**
 * The bulk import route (P1-25).
 *
 * What the route owns: who may import, where the tenant comes from, what is
 * refused before anything is written, and what the answer says when an import
 * stops part-way. The batching itself is asserted against a real database in
 * `products-port.integration.test.ts`.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const IMPORT = '/v1/dashboard/products/import';

const ROW = {
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
};

/** Built at runtime: a key-shaped literal is what the secret scan stops (P0-56). */
const KEY = randomUUID();
const RUN = 'run-1';

/**
 * A port that claims every key and stores whatever it is handed, unless a test
 * says otherwise: the P1-25 cases read as they did before the key existed, and
 * the P1-26 cases override exactly the half they are about.
 */
const app = (products: Partial<ProductsPort>) =>
  createApp({
    auth: signedIn(),
    readMemberships: oneMembership(TENANT, 'EDITOR'),
    products: productsPort({
      claimImport: () => Promise.resolve({ outcome: 'claimed', runId: RUN }),
      completeImport: () => Promise.resolve(),
      ...products,
    }),
  });

/** Where the rows came from. Every earlier case sends one, as the dashboard does (P1-28). */
const SOURCE = { entryPoint: 'paste' } as const;

const withSource = (body: unknown): unknown =>
  typeof body === 'object' && body !== null && !('source' in body)
    ? { ...body, source: SOURCE }
    : body;

const post = (
  built: ReturnType<typeof createApp>,
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': KEY },
) =>
  built.request(IMPORT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(withSource(body)),
  });

const applied = (result: Partial<ImportProductsResult> = {}) =>
  vi.fn<(command: ImportProductsCommand) => Promise<ImportProductsResult>>(() =>
    Promise.resolve({ outcomes: [], stoppedAt: null, ...result }),
  );

/**
 * What the route handed the port, with its deadline taken as given: when it was
 * set is asserted on its own below, and exact equality still catches a stray field.
 */
const commandOf = (importRows: ReturnType<typeof applied>) => {
  const [command] = importRows.mock.calls[0] ?? [];
  return { command, deadline: command?.deadline };
};

const messageOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { message: string } }).error.message;

describe('importing', () => {
  it('lets an EDITOR import, and answers with every outcome and the counts', async () => {
    const importRows = applied({
      outcomes: [
        { index: 0, outcome: 'created', productId: 'p-1' },
        { index: 1, outcome: 'updated', productId: 'p-2', reindexed: false, archived: true },
      ],
    });

    const response = await post(app({ importRows }), { rows: [ROW, { ...ROW, sku: 'ETN-2020' }] });

    expect(response.status).toBe(200);

    const body = productsImportedResponse.parse(await response.json());
    expect(body.counts).toEqual({
      created: 1,
      updated: 1,
      unchanged: 0,
      duplicateSku: 0,
      archived: 1,
    });
    expect(body.stoppedAt).toBeNull();

    const { command, deadline } = commandOf(importRows);
    expect(command).toEqual({
      tenantId: TENANT,
      rows: [ROW, { ...ROW, sku: 'ETN-2020' }],
      deadline,
    });
  });

  it('takes the tenant from the membership, never from a row', async () => {
    // P0-48. A row carrying another winery's id parses with the field stripped.
    const importRows = applied();

    await post(app({ importRows }), {
      rows: [{ ...ROW, tenantId: '22222222-2222-2222-2222-222222222222' }],
    });

    const { command, deadline } = commandOf(importRows);
    expect(command).toEqual({ tenantId: TENANT, rows: [ROW], deadline });
  });
});

describe('what is refused before anything is written', () => {
  it.each([
    ['no body at all', 'not json'],
    ['a body without rows', { products: [ROW] }],
    ['an empty import', { rows: [] }],
    ['a body with anything else in it', { rows: [ROW], mode: 'replace' }],
  ])('refuses %s', async (_case, body) => {
    const importRows = applied();

    const response = await post(app({ importRows }), body);

    expect(response.status).toBe(422);
    expect(await messageOf(response)).toContain(String(MAX_IMPORT_ROWS));
    expect(importRows).not.toHaveBeenCalled();
  });

  it('refuses more rows than the cap, on the server as well as in the browser', async () => {
    const importRows = applied();

    const response = await post(app({ importRows }), {
      rows: Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, index) => ({
        ...ROW,
        sku: `S-${String(index)}`,
      })),
    });

    expect(response.status).toBe(422);
    expect(importRows).not.toHaveBeenCalled();
  });

  it('refuses a body over the request cap before parsing it, naming the limit', async () => {
    // P1-27. Under the platform's 6 MB, so the refusal a caller reads is this one.
    const importRows = applied();

    const response = await post(app({ importRows }), {
      rows: [{ ...ROW, tastingNotes: 'x'.repeat(MAX_IMPORT_BODY_BYTES) }],
    });

    expect(response.status).toBe(422);
    expect(await messageOf(response)).toContain('at most 5 MB');
    expect(importRows).not.toHaveBeenCalled();
  });

  it('counts the body in bytes, so accented notes cannot slip under the cap', async () => {
    // Each "è" is two bytes: counted as characters, this body would fit.
    const importRows = applied();

    const response = await post(app({ importRows }), {
      rows: [{ ...ROW, tastingNotes: 'è'.repeat(MAX_IMPORT_BODY_BYTES / 2) }],
    });

    expect(response.status).toBe(422);
    expect(importRows).not.toHaveBeenCalled();
  });

  it('refuses the whole import when a row breaks the contract, naming the row', async () => {
    const importRows = applied();

    const response = await post(app({ importRows }), {
      rows: [ROW, { ...ROW, sku: '' }, { ...ROW, sku: 'OK' }, { ...ROW, priceCents: -1 }],
    });

    expect(response.status).toBe(422);
    const message = await messageOf(response);
    expect(message).toContain('Row 2, 4 ');
    expect(message).toContain('nothing was imported');
    expect(importRows).not.toHaveBeenCalled();
  });

  it('names the first five broken rows and counts the rest', async () => {
    const broken = Array.from({ length: 7 }, () => ({ ...ROW, name: '' }));

    const response = await post(app({ importRows: applied() }), { rows: broken });

    expect(await messageOf(response)).toContain('Row 1, 2, 3, 4, 5 and 2 more');
  });
});

describe('an import that stops part-way', () => {
  it('says how far it got, numbered as a seller counts rows, and never why', async () => {
    const importRows = applied({
      outcomes: Array.from({ length: 400 }, (_, index) => ({
        index,
        outcome: 'created' as const,
        productId: `p-${String(index)}`,
      })),
      stoppedAt: {
        batch: 3,
        fromIndex: 400,
        toIndex: 599,
        reason: 'failed',
        cause: new Error('connect ECONNREFUSED postgres://app_rw:hunter2@db.internal/app'),
      },
    });

    const response = await post(app({ importRows }), { rows: [ROW] });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(productsImportedResponse.parse(JSON.parse(text)).stoppedAt).toEqual({
      batch: 3,
      fromRow: 401,
      toRow: 600,
      reason: 'failed',
    });
    // P0-55: a driver error can carry a connection string. It goes to the log, not here.
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ECONNREFUSED');
  });

  it('says an import that ran out of time stopped for time, and does not log it as a failure', async () => {
    // Review fix: a catalogue too large for one request is the import working, not failing.
    const error = vi.spyOn(logger, 'error');
    const importRows = applied({
      outcomes: [{ index: 0, outcome: 'created', productId: 'p-1' }],
      stoppedAt: { batch: 2, fromIndex: 1, toIndex: 1, reason: 'time-budget', cause: undefined },
    });

    const response = await post(app({ importRows }), { rows: [ROW, { ...ROW, sku: 'B' }] });

    expect(productsImportedResponse.parse(await response.json()).stoppedAt).toEqual({
      batch: 2,
      fromRow: 2,
      toRow: 2,
      reason: 'time-budget',
    });
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('gives the import a deadline one time budget after the request arrived', async () => {
    const importRows = applied();
    const before = Date.now();

    await post(app({ importRows }), { rows: [ROW] });

    const { deadline = Number.NaN } = commandOf(importRows);
    expect(deadline).toBeGreaterThanOrEqual(before + IMPORT_TIME_BUDGET_MS);
    expect(deadline).toBeLessThanOrEqual(Date.now() + IMPORT_TIME_BUDGET_MS);
  });
});

describe('the idempotency key (P1-26)', () => {
  const claiming = (claim: ImportRunClaim) =>
    vi.fn<(command: ClaimImportCommand) => Promise<ImportRunClaim>>(() => Promise.resolve(claim));

  const storing = () =>
    vi.fn<(command: CompleteImportCommand) => Promise<void>>(() => Promise.resolve());

  it.each([
    ['no key', {}],
    ['a key that is not a UUID', { 'idempotency-key': 'retry-1' }],
  ])(
    'refuses an import with %s, before reading a row or claiming anything',
    async (_case, headers) => {
      const importRows = applied();
      const claimImport = claiming({ outcome: 'claimed', runId: RUN });

      const response = await post(app({ importRows, claimImport }), { rows: [ROW] }, headers);

      expect(response.status).toBe(422);
      expect(await messageOf(response)).toContain('Idempotency-Key');
      expect(claimImport).not.toHaveBeenCalled();
      expect(importRows).not.toHaveBeenCalled();
    },
  );

  it('claims the key for the membership tenant, then stores exactly the body it answers with', async () => {
    const claimImport = claiming({ outcome: 'claimed', runId: RUN });
    const completeImport = storing();
    const importRows = applied({ outcomes: [{ index: 0, outcome: 'created', productId: 'p-1' }] });

    const response = await post(app({ importRows, claimImport, completeImport }), {
      rows: [ROW],
    });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const [claimed] = claimImport.mock.calls[0] ?? [];
    expect(claimed).toMatchObject({ tenantId: TENANT, idempotencyKey: KEY });
    expect(claimed?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(completeImport.mock.calls[0]?.[0]).toMatchObject({
      tenantId: TENANT,
      runId: RUN,
      result: body,
    });
  });

  it('fingerprints the rows as parsed, so the same wines in another field order are the same import', async () => {
    const claimImport = claiming({ outcome: 'claimed', runId: RUN });
    const built = app({ importRows: applied(), claimImport });
    const reordered = Object.fromEntries(Object.entries(ROW).reverse());

    await post(built, { rows: [ROW] });
    await post(built, { rows: [{ ...reordered, colour: 'rosso' }] });
    await post(built, { rows: [{ ...ROW, priceCents: 4600 }] });

    expect(claimImport).toHaveBeenCalledTimes(3);
    const [first, sameWines, repriced] = claimImport.mock.calls.map(
      ([command]) => command.requestHash,
    );
    expect(sameWines).toBe(first);
    expect(repriced).not.toBe(first);
  });

  it('answers a repeat with the stored body, importing nothing and storing nothing', async () => {
    const stored = {
      outcomes: [{ index: 0, outcome: 'created', productId: 'p-1' }],
      counts: { created: 1, updated: 0, unchanged: 0, duplicateSku: 0, archived: 0 },
      stoppedAt: null,
    };
    const importRows = applied();
    const completeImport = storing();

    const response = await post(
      app({
        importRows,
        completeImport,
        claimImport: claiming({ outcome: 'replay', result: stored }),
      }),
      { rows: [ROW] },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stored);
    expect(importRows).not.toHaveBeenCalled();
    expect(completeImport).not.toHaveBeenCalled();
  });

  it.each([
    ['different-body', 'already used for an import with different rows'],
    ['in-progress', 'released after 30 seconds'],
  ] as const)('refuses a %s repeat with 409, importing nothing', async (outcome, says) => {
    const importRows = applied();

    const response = await post(app({ importRows, claimImport: claiming({ outcome }) }), {
      rows: [ROW],
    });

    expect(response.status).toBe(409);
    expect(await messageOf(response)).toContain(says);
    expect(importRows).not.toHaveBeenCalled();
  });

  it('uses no key up on an import refused for a broken row, so the fixed retry can carry it', async () => {
    const claimImport = claiming({ outcome: 'claimed', runId: RUN });

    const response = await post(app({ importRows: applied(), claimImport }), {
      rows: [{ ...ROW, sku: '' }],
    });

    expect(response.status).toBe(422);
    expect(claimImport).not.toHaveBeenCalled();
  });

  it('stores an import that stopped part-way, without the cause, since how far it got is the answer', async () => {
    const completeImport = storing();
    const importRows = applied({
      stoppedAt: {
        batch: 1,
        fromIndex: 0,
        toIndex: 0,
        reason: 'failed',
        cause: new Error('connect ECONNREFUSED postgres://app_rw:hunter2@db.internal/app'),
      },
    });

    await post(app({ importRows, completeImport }), { rows: [ROW] });

    const stored = completeImport.mock.calls[0]?.[0].result;
    expect(stored).toMatchObject({ stoppedAt: { batch: 1, fromRow: 1, toRow: 1 } });
    expect(JSON.stringify(stored)).not.toContain('hunter2');
  });
});

describe('the audit entry (P1-28)', () => {
  const storing = () =>
    vi.fn<(command: CompleteImportCommand) => Promise<void>>(() => Promise.resolve());

  const auditOf = (completeImport: ReturnType<typeof storing>) =>
    completeImport.mock.calls[0]?.[0].audit;

  it.each([
    ['no source', { rows: [ROW], source: undefined }],
    ['an entry point the dashboard does not have', { rows: [ROW], source: { entryPoint: 'api' } }],
    [
      'a file name longer than a file system allows',
      { rows: [ROW], source: { entryPoint: 'file', filename: 'x'.repeat(256) } },
    ],
    [
      'anything else in the source',
      { rows: [ROW], source: { entryPoint: 'file', path: 'C:/vini' } },
    ],
  ])('refuses an import with %s, before claiming anything', async (_case, body) => {
    const claimImport = vi.fn<(command: ClaimImportCommand) => Promise<ImportRunClaim>>(() =>
      Promise.resolve({ outcome: 'claimed', runId: RUN }),
    );

    const response = await post(app({ importRows: applied(), claimImport }), body);

    expect(response.status).toBe(422);
    expect(claimImport).not.toHaveBeenCalled();
  });

  it('records the key, where the rows came from, the file and the counts', async () => {
    const completeImport = storing();
    const importRows = applied({
      outcomes: [
        { index: 0, outcome: 'created', productId: 'p-1' },
        { index: 1, outcome: 'updated', productId: 'p-2', reindexed: true, archived: false },
        { index: 2, outcome: 'duplicate-sku', sku: 'X' },
      ],
    });

    await post(app({ importRows, completeImport }), {
      rows: [ROW, { ...ROW, sku: 'B' }, { ...ROW, sku: 'C' }],
      source: { entryPoint: 'file', filename: 'listino.csv' },
    });

    expect(auditOf(completeImport)).toEqual({
      idempotencyKey: KEY,
      entryPoint: 'file',
      filename: 'listino.csv',
      counts: { created: 1, updated: 1, unchanged: 0, duplicateSku: 1, archived: 0 },
    });
  });

  it('writes one for an import that stopped part-way after rows had applied', async () => {
    const completeImport = storing();
    const importRows = applied({
      outcomes: [
        { index: 0, outcome: 'unchanged', productId: 'p-1', reindexed: false, archived: false },
      ],
      stoppedAt: { batch: 2, fromIndex: 1, toIndex: 1, reason: 'failed', cause: new Error('down') },
    });

    await post(app({ importRows, completeImport }), { rows: [ROW] });

    expect(auditOf(completeImport)).toMatchObject({ counts: { unchanged: 1 } });
  });

  it('writes none for an import that failed in its first batch', async () => {
    const completeImport = storing();
    const importRows = applied({
      stoppedAt: { batch: 1, fromIndex: 0, toIndex: 0, reason: 'failed', cause: new Error('down') },
    });

    await post(app({ importRows, completeImport }), { rows: [ROW] });

    expect(completeImport).toHaveBeenCalledTimes(1);
    expect(auditOf(completeImport)).toBeNull();
  });

  it('writes none for an import that refused every row as a duplicate', async () => {
    const completeImport = storing();
    const importRows = applied({
      outcomes: [
        { index: 0, outcome: 'duplicate-sku', sku: 'X' },
        { index: 1, outcome: 'duplicate-sku', sku: 'X' },
      ],
    });

    await post(app({ importRows, completeImport }), { rows: [ROW, ROW] });

    expect(auditOf(completeImport)).toBeNull();
  });
});

describe('countImportOutcomes', () => {
  it('counts each kind, and archived matches whether updated or unchanged', () => {
    expect(
      countImportOutcomes([
        { index: 0, outcome: 'created', productId: 'a' },
        { index: 1, outcome: 'updated', productId: 'b', reindexed: true, archived: false },
        { index: 2, outcome: 'unchanged', productId: 'c', reindexed: false, archived: true },
        { index: 3, outcome: 'updated', productId: 'd', reindexed: false, archived: true },
        { index: 4, outcome: 'duplicate-sku', sku: 'X' },
        { index: 5, outcome: 'duplicate-sku', sku: 'X' },
      ]),
    ).toEqual({ created: 1, updated: 2, unchanged: 1, duplicateSku: 2, archived: 2 });
  });
});
