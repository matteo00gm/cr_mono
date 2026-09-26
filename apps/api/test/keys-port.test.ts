import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Issuing and rotating a winery's keys (P4-09, ADR 0025).
 *
 * **The property this file exists for is where the secret key goes**, and the
 * answer has to be: into the response, once, and nowhere else. Not into the
 * statements, which take a hash. Not into the audit row, which records that a
 * key changed. So every case below captures everything that crossed the port's
 * boundaries and searches it for the plaintext.
 *
 * `@catalogorosso/db` is mocked for the reason `members-port.test.ts` gives.
 * That the hash really is what lands in the column is asserted against real
 * Postgres in `widget-keys.integration.test.ts`.
 */

/** Everything handed to the database, so it can be searched for the secret. */
const toDatabase: unknown[] = [];

interface Keys {
  id: string;
  publicKey: string;
  secretKeyPrefix: string;
  secretKeyLast4: string;
  createdAt: Date;
  updatedAt: Date;
}

const state = {
  active: undefined as Keys | undefined,
  inserted: undefined as Keys | undefined,
  replaced: undefined as Keys | undefined,
  inGrace: undefined as { publicKey: string; graceUntil: Date } | undefined,
  rotated: undefined as
    { active: Keys; previous: { publicKey: string; graceUntil: Date } } | undefined,
  committed: true,
};

const stored = (overrides: Partial<Keys> = {}): Keys => ({
  id: 'k1',
  publicKey: 'pk_live_stored',
  secretKeyPrefix: 'sk_live_Ab3x',
  secretKeyLast4: 'Wq7Z',
  createdAt: new Date('2026-09-26T09:00:00.000Z'),
  updatedAt: new Date('2026-09-26T09:00:00.000Z'),
  ...overrides,
});

vi.mock('@catalogorosso/db', () => ({
  withTenant: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    try {
      return await fn({});
    } catch (error) {
      state.committed = false;
      throw error;
    }
  },
  readActiveKeys: () => Promise.resolve(state.active),
  readKeyInGrace: () => Promise.resolve(state.inGrace),
  rotatePublicKey: (_tx: unknown, publicKey: string) => {
    toDatabase.push({ publicKey });

    return Promise.resolve(state.rotated);
  },
  insertKeys: (_tx: unknown, keys: unknown) => {
    toDatabase.push(keys);

    return Promise.resolve(state.inserted);
  },
  replaceSecretKey: (_tx: unknown, secret: unknown) => {
    toDatabase.push(secret);

    return Promise.resolve(state.replaced);
  },
}));

const { createKeysPort, unconfiguredKeys } = await import('../src/keys.js');
const { hashSecretKey, looksLikeSecretKey } = await import('@catalogorosso/security/api-keys');

interface Entry {
  readonly action: string;
  readonly target?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

const written: Entry[] = [];
const record = (_tx: unknown, entry: Entry) => {
  written.push(entry);

  return Promise.resolve();
};

/** Built at runtime, never written into this file (P0-56). */
const SECRET = ['sk', 'live', 'Q'.repeat(4) + 'z'.repeat(35) + 'TAIL'].join('_');

const port = () =>
  createKeysPort({
    audit: record,
    newSecret: () => SECRET,
    newPublic: () => 'pk_live_fresh',
  });

/** Every string reachable from a value, so a secret nested anywhere is found. */
const strings = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : typeof value === 'object' && value !== null
      ? Object.values(value).flatMap(strings)
      : [];

beforeEach(() => {
  toDatabase.length = 0;
  written.length = 0;
  state.active = stored();
  state.inserted = stored({ publicKey: 'pk_live_fresh' });
  state.replaced = stored({ secretKeyPrefix: 'sk_live_QQQQ', secretKeyLast4: 'TAIL' });
  state.inGrace = undefined;
  state.rotated = {
    active: stored({ publicKey: 'pk_live_fresh' }),
    previous: { publicKey: 'pk_live_stored', graceUntil: new Date('2026-09-27T09:00:00.000Z') },
  };
  state.committed = true;
});

describe('issuing a winery its first keys', () => {
  it('hands the secret back, this once', async () => {
    const issued = await port().create('t1');

    expect(issued.secretKey).toBe(SECRET);
    expect(issued.publicKey).toBe('pk_live_fresh');
  });

  it('never hands the database the secret itself', async () => {
    /*
     * **The whole point.** The statements take a hash and a hint. A function
     * that took the key would be one careless log line away from writing it
     * somewhere it could not be taken back from.
     */
    await port().create('t1');

    const everything = toDatabase.flatMap(strings);

    expect(everything).not.toContain(SECRET);
    expect(everything.some((value) => value.includes(SECRET.slice(8, 20)))).toBe(false);
  });

  it('stores the SHA-256 of the key, and nothing else about its body', async () => {
    await port().create('t1');

    expect(toDatabase[0]).toMatchObject({
      secretKeyHash: hashSecretKey(SECRET),
      secretKeyPrefix: 'sk_live_QQQQ',
      secretKeyLast4: 'TAIL',
    });
  });

  it('records that keys were issued, without the key', async () => {
    await port().create('t1');

    expect(written).toHaveLength(1);
    expect(written[0]?.action).toBe('keys.created');
    expect(written.flatMap(strings)).not.toContain(SECRET);
    expect(written.flatMap(strings).some((value) => value.includes(SECRET.slice(8, 20)))).toBe(
      false,
    );
  });

  it('records the hint, so "which key was live?" has an answer later', async () => {
    await port().create('t1');

    expect(written[0]?.metadata).toEqual({
      secretKeyPrefix: 'sk_live_QQQQ',
      secretKeyLast4: 'TAIL',
    });
  });

  it('refuses a second pair rather than replacing the first', async () => {
    /*
     * Replacing would silently invalidate a secret the seller may already have
     * deployed, and hand them one they did not ask for. The partial unique
     * index decides; this is what a lost race looks like from here.
     */
    state.inserted = undefined;

    await expect(port().create('t1')).rejects.toMatchObject({ kind: 'conflict' });
  });

  it('tells a seller how to get a new secret instead', async () => {
    state.inserted = undefined;

    await expect(port().create('t1')).rejects.toThrow(/rotate/iu);
  });

  it('writes no audit row for a refusal', async () => {
    state.inserted = undefined;

    await expect(port().create('t1')).rejects.toThrow();

    expect(written).toEqual([]);
  });

  it('uses a real generator when nobody injects one', async () => {
    /* The default is what ships. A test that only ever injected a fixed key
     * would say nothing about the key a seller actually gets. */
    const issued = await createKeysPort({ audit: record }).create('t1');

    expect(looksLikeSecretKey(issued.secretKey)).toBe(true);
  });
});

describe('rotating the secret key', () => {
  it('hands the new secret back, this once', async () => {
    const rotated = await port().rotateSecret('t1');

    expect(rotated.secretKey).toBe(SECRET);
  });

  it('never hands the database the new secret itself', async () => {
    await port().rotateSecret('t1');

    expect(toDatabase.flatMap(strings)).not.toContain(SECRET);
    expect(toDatabase[0]).toMatchObject({ secretKeyHash: hashSecretKey(SECRET) });
  });

  it('leaves the public key where it is', async () => {
    /* The public key is live on the seller's pages. Rotating the secret is not
     * a request to break them. */
    const rotated = await port().rotateSecret('t1');

    expect(rotated.publicKey).toBe('pk_live_stored');
    expect(toDatabase[0]).not.toHaveProperty('publicKey');
  });

  it('records the rotation, without the key', async () => {
    await port().rotateSecret('t1');

    expect(written[0]?.action).toBe('keys.secret_rotated');
    expect(written.flatMap(strings)).not.toContain(SECRET);
  });

  it('is a 404 for a winery with no keys yet', async () => {
    state.replaced = undefined;

    await expect(port().rotateSecret('t1')).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('reading the keys', () => {
  it('gives the public key and a hint of the secret, and nothing more', async () => {
    const view = await port().read('t1');

    expect(view).toEqual({
      publicKey: 'pk_live_stored',
      secretKeyPrefix: 'sk_live_Ab3x',
      secretKeyLast4: 'Wq7Z',
      createdAt: '2026-09-26T09:00:00.000Z',
      updatedAt: '2026-09-26T09:00:00.000Z',
      previous: null,
    });
  });

  it('shows the key still in its grace window, with its deadline', async () => {
    /* A seller who has not redeployed yet needs to know how long they have. */
    state.inGrace = { publicKey: 'pk_live_old', graceUntil: new Date('2026-09-27T09:00:00.000Z') };

    const view = await port().read('t1');

    expect(view.previous).toEqual({
      publicKey: 'pk_live_old',
      validUntil: '2026-09-27T09:00:00.000Z',
    });
  });

  it('has no secret on it at all, however it was issued', async () => {
    const view = await port().read('t1');

    expect(view).not.toHaveProperty('secretKey');
    expect(view).not.toHaveProperty('secretKeyHash');
  });

  it('is a 404 before any keys exist', async () => {
    state.active = undefined;

    await expect(port().read('t1')).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('with no port configured', () => {
  it.each(['read', 'create', 'rotateSecret'] as const)('refuses %s loudly', async (method) => {
    await expect(unconfiguredKeys[method]('t1')).rejects.toThrow(/composition root/iu);
  });
});

describe('rotating the public key (P4-08)', () => {
  it('hands back the new key and the old one with its deadline', async () => {
    const view = await port().rotatePublic('t1');

    expect(view.publicKey).toBe('pk_live_fresh');
    expect(view.previous).toEqual({
      publicKey: 'pk_live_stored',
      validUntil: '2026-09-27T09:00:00.000Z',
    });
  });

  it('asks the database for a freshly generated key', async () => {
    await port().rotatePublic('t1');

    expect(toDatabase).toEqual([{ publicKey: 'pk_live_fresh' }]);
  });

  it('records both keys, because "which key was live when?" has two answers for a day', async () => {
    await port().rotatePublic('t1');

    expect(written).toHaveLength(1);
    expect(written[0]?.action).toBe('keys.public_rotated');
    expect(written[0]?.target).toBe('pk_live_fresh');
    expect(written[0]?.metadata).toEqual({
      previousPublicKey: 'pk_live_stored',
      previousValidUntil: '2026-09-27T09:00:00.000Z',
    });
  });

  it('carries no secret, before or after', async () => {
    const view = await port().rotatePublic('t1');

    expect(view).not.toHaveProperty('secretKey');
    expect(written.flatMap(strings)).not.toContain(SECRET);
  });

  it('is a 404 for a winery with no keys', async () => {
    state.rotated = undefined;

    await expect(port().rotatePublic('t1')).rejects.toMatchObject({ kind: 'not_found' });
    expect(written).toEqual([]);
  });

  it('refuses loudly when no port is configured', async () => {
    await expect(unconfiguredKeys.rotatePublic('t1')).rejects.toThrow(/composition root/iu);
  });
});
