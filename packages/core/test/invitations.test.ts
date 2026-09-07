import { describe, expect, it } from 'vitest';

import {
  hashInvitationToken,
  InvalidInviteError,
  invitationExpiry,
  invitationIsFor,
  INVITATION_TTL_DAYS,
  issueInvitationToken,
  prepareInvite,
  tokenHashEquals,
} from '../src/invitations.js';

/**
 * Invitation tokens and the rules around them (P0-51).
 *
 * The parts that can be got wrong without anything failing: a token that is
 * stored in the clear, an address that normalises differently on the way in
 * than on the way out, an acceptance that admits whoever holds the link.
 */

const NOW = new Date('2026-09-06T12:00:00.000Z');

describe('tokens', () => {
  it('are unguessable and never repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => issueInvitationToken().token));

    // 32 bytes from a CSPRNG. A collision here would mean the source is not one.
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('are URL-safe, so the link in the mail is the token', () => {
    for (let i = 0; i < 50; i += 1) {
      // Percent-encoding a token is a way to end up with two representations of
      // it, and a lookup that misses on whichever one the mail client mangled.
      expect(issueInvitationToken().token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('hash to a stable hex digest', () => {
    const { token, tokenHash } = issueInvitationToken();

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInvitationToken(token)).toBe(tokenHash);
  });

  it('never hands back the plaintext alongside what is stored', () => {
    const { token, tokenHash } = issueInvitationToken();

    // The property the whole scheme rests on: a dump of `invitations` must not
    // grant membership of every tenant with an open invitation.
    expect(tokenHash).not.toContain(token);
    expect(token).not.toBe(tokenHash);
  });
});

describe('tokenHashEquals', () => {
  it('matches identical hashes and rejects different ones', () => {
    const hash = hashInvitationToken('abc');

    expect(tokenHashEquals(hash, hash)).toBe(true);
    expect(tokenHashEquals(hash, hashInvitationToken('abd'))).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // `timingSafeEqual` throws on unequal lengths, and an exception escaping
    // here would be a 500 on a request that should simply be refused.
    expect(tokenHashEquals('short', hashInvitationToken('abc'))).toBe(false);
  });
});

describe('prepareInvite', () => {
  it('normalises the address', () => {
    const prepared = prepareInvite(
      { email: '  Anna@Cantina.Example  ', role: 'EDITOR' },
      { now: NOW },
    );

    /*
     * The uniqueness that makes a re-invite a no-op is a plain string
     * comparison in Postgres. Without this, `Anna@…` and `anna@…` are two open
     * invitations for one seat, and revoking one leaves the other live.
     */
    expect(prepared.email).toBe('anna@cantina.example');
  });

  it('keeps the role the inviter chose', () => {
    expect(prepareInvite({ email: 'a@b.example', role: 'OWNER' }, { now: NOW }).role).toBe('OWNER');
  });

  it('expires seven days out by default', () => {
    const prepared = prepareInvite({ email: 'a@b.example', role: 'EDITOR' }, { now: NOW });

    expect(prepared.expiresAt).toEqual(invitationExpiry(NOW, INVITATION_TTL_DAYS));
    expect(prepared.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('refuses something that is not an address', () => {
    // Catches the interpolated `undefined` and the display name, both of which
    // would otherwise become a guaranteed bounce against our sending domain.
    expect(() => prepareInvite({ email: 'anna', role: 'EDITOR' }, { now: NOW })).toThrow(
      InvalidInviteError,
    );
    expect(() => prepareInvite({ email: '   ', role: 'EDITOR' }, { now: NOW })).toThrow(
      InvalidInviteError,
    );
  });
});

describe('invitationIsFor', () => {
  it('admits the invited address, whatever its case', () => {
    expect(
      invitationIsFor({ email: 'anna@cantina.example' }, { email: 'Anna@Cantina.Example' }),
    ).toBe(true);
  });

  it('refuses anybody else', () => {
    /*
     * The deliberate cost of this row. Links get forwarded, quoted in tickets
     * and left in mailboxes that change hands; without this check whoever opens
     * the mail joins the winery. The price is an invitee who signed up under a
     * different address needing a fresh invitation, which is a support message
     * rather than a security incident.
     */
    expect(
      invitationIsFor({ email: 'anna@cantina.example' }, { email: 'mallory@evil.example' }),
    ).toBe(false);
  });
});
