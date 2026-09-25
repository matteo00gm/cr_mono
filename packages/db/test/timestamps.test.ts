import { describe, expect, it, vi } from 'vitest';

import { readOpenInvitations } from '../src/invitations.js';
import { readRoster } from '../src/memberships.js';
import { asDate, asDateOrNull } from '../src/timestamps.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * Timestamps out of a hand-written statement.
 *
 * **A raw `execute` returns `timestamptz` as a string, not a `Date`.** Drizzle
 * parses column types for a typed select and does nothing of the kind for a
 * statement written by hand, so every row cast that claims `Date` is claiming
 * something untrue at runtime.
 *
 * **This file exists because a mocked driver cannot find that.** `rate-limit.ts`
 * wrote down why when CI caught it there: the double and the code were written
 * from the same assumption, so they agreed with each other and not with
 * Postgres. So every case below feeds in the string form Postgres actually
 * produces, rather than the `Date` a fake would helpfully hand back.
 */

/** What postgres-js hands back for a `timestamptz`, exactly. */
const PG = '2026-10-02 01:01:04.326752+00';

const answering = (rows: readonly unknown[]): DbTransaction =>
  ({ execute: vi.fn(() => Promise.resolve(rows)) }) as unknown as DbTransaction;

describe('reading a timestamp the driver handed back', () => {
  it('turns the string form into a Date', () => {
    const at = asDate(PG);

    expect(at).toBeInstanceOf(Date);
    expect(at.toISOString()).toBe('2026-10-02T01:01:04.326Z');
  });

  it('leaves a Date alone', () => {
    const already = new Date('2026-10-02T01:01:04.326Z');

    expect(asDate(already)).toBe(already);
  });

  it('keeps null null, rather than making it 1970', () => {
    /* `new Date(null)` is the epoch, which reads on a screen as a deadline that
     * passed before the product existed. */
    expect(asDateOrNull(null)).toBeNull();
    expect(asDateOrNull(PG)).toBeInstanceOf(Date);
  });

  it('produces something the wire contract accepts', async () => {
    /*
     * **The assertion that names the actual failure.** The dashboard's client
     * parses every response against `z.iso.datetime()`. Postgres's format is a
     * space instead of a `T` and `+00` instead of `+00:00`, so the parse throws
     * and the screen does not load at all — a quieter failure than the thrown
     * `TypeError` the same bug caused in the domains port, and a worse one.
     */
    const { z } = await import('zod');
    const iso = z.iso.datetime();

    expect(iso.safeParse(PG).success).toBe(false);
    expect(iso.safeParse(JSON.parse(JSON.stringify(asDate(PG))) as string).success).toBe(true);
  });
});

describe('the roster', () => {
  it('gives back a Date even though the driver gave back a string', async () => {
    const tx = answering([
      { user_id: 'user_anna', role: 'OWNER', created_at: PG, email: 'a@b.example', name: 'Anna' },
    ]);

    const [entry] = await readRoster(tx);

    expect(entry?.joinedAt).toBeInstanceOf(Date);
    expect(entry?.joinedAt.toISOString()).toBe('2026-10-02T01:01:04.326Z');
  });
});

describe('the open invitations', () => {
  it('gives back Dates even though the driver gave back strings', async () => {
    const tx = answering([
      {
        id: 'inv1',
        email: 'anna@cantina.example',
        role: 'EDITOR',
        invited_by: 'user_matteo',
        expires_at: PG,
        created_at: PG,
      },
    ]);

    const [invitation] = await readOpenInvitations(tx);

    expect(invitation?.expiresAt).toBeInstanceOf(Date);
    expect(invitation?.createdAt).toBeInstanceOf(Date);
  });

  it('serialises to something the members screen can parse', async () => {
    const { z } = await import('zod');
    const tx = answering([
      {
        id: 'inv1',
        email: 'anna@cantina.example',
        role: 'EDITOR',
        invited_by: 'user_matteo',
        expires_at: PG,
        created_at: PG,
      },
    ]);

    const [invitation] = await readOpenInvitations(tx);
    const onTheWire = JSON.parse(JSON.stringify(invitation)) as { expiresAt: string };

    expect(z.iso.datetime().safeParse(onTheWire.expiresAt).success).toBe(true);
  });
});
