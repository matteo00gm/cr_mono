import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Role } from '@catalogorosso/security';

import { normaliseAddress } from './email/address.js';

/**
 * Invitation tokens and their rules (P0-51).
 *
 * No database here, for the P0-09 reason: what a token is, how long it lives
 * and what an acceptance is allowed to decide are decisions, and decisions
 * belong in a package whose tests are plain unit tests. The statements live in
 * `@catalogorosso/db`.
 */

/**
 * Seven days.
 *
 * Long enough that an invitation sent on a Friday survives the weekend and a
 * holiday; short enough that a mailbox compromised months later does not hand
 * over a winery. The expiry is the only thing limiting the blast radius of an
 * invitation email sitting in an inbox, so "never expires" is not an option and
 * "24 hours" produces a support burden that gets solved by lengthening it
 * anyway.
 */
export const INVITATION_TTL_DAYS = 7;

/** 256 bits. Not a guessable number of characters — a guessable one is none. */
const TOKEN_BYTES = 32;

/**
 * Hashes a token for storage and lookup.
 *
 * **SHA-256, deliberately not a password KDF.** The token is 32 bytes from a
 * CSPRNG, so there is no dictionary to attack and no low-entropy input to
 * stretch: argon2id would add a hundred milliseconds to every acceptance and
 * buy nothing. That reasoning does *not* transfer to `widget_keys`' secret,
 * which is why that column is argon2id and this one is not — the difference is
 * the entropy of the input, not the sensitivity of the value.
 *
 * Hex rather than base64url so the stored value has one representation. A
 * column that can hold two encodings of the same hash is a column where a
 * lookup silently misses.
 */
export const hashInvitationToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export interface IssuedToken {
  /** Goes in the email, and is never stored. */
  readonly token: string;
  /** Goes in the database, and is never emailed. */
  readonly tokenHash: string;
}

export const issueInvitationToken = (): IssuedToken => {
  // base64url: safe in a URL with no escaping, so the link in the mail is the
  // token rather than an encoding of it.
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
};

/**
 * Constant-time comparison of two token hashes.
 *
 * Not used by the lookup — that is an indexed equality in Postgres, and timing
 * a B-tree probe over a 256-bit space is not a practical attack. It exists for
 * the callers that compare a hash they were handed against one they computed,
 * where the naive `===` is the classic finding, and so that there is one right
 * answer in the codebase to copy.
 */
export const tokenHashEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Hashes here are fixed-width, so unequal lengths mean malformed
  // input rather than a near miss.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

export const invitationExpiry = (now: Date, days: number = INVITATION_TTL_DAYS): Date =>
  new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

/* ------------------------------------------------------------------ invite */

export class InvalidInviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInviteError';
  }
}

export interface InviteRequest {
  readonly email: string;
  readonly role: Role;
}

export interface PreparedInvite {
  readonly email: string;
  readonly role: Role;
  readonly token: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/**
 * Validates and normalises an invite, and mints its token.
 *
 * Separate from the handler so the interesting part — normalisation, the role
 * check, the expiry — is testable without a request or a database.
 */
export const prepareInvite = (
  request: InviteRequest,
  options: { readonly now: Date; readonly ttlDays?: number | undefined },
): PreparedInvite => {
  const email = normaliseAddress(request.email);

  /*
   * Normalised here rather than trusted from the request, because the
   * uniqueness that makes a re-invite a no-op is a plain string comparison in
   * Postgres: `Bob@x.com` and `bob@x.com` would otherwise be two open
   * invitations for one seat, and only one of them gets revoked when somebody
   * changes their mind.
   */
  if (email === '' || !email.includes('@')) {
    throw new InvalidInviteError('That does not look like an email address.');
  }

  const { token, tokenHash } = issueInvitationToken();

  return {
    email,
    role: request.role,
    token,
    tokenHash,
    expiresAt: invitationExpiry(options.now, options.ttlDays ?? INVITATION_TTL_DAYS),
  };
};

/* ------------------------------------------------------------------ accept */

/**
 * What an acceptance is allowed to decide: nothing.
 *
 * This type has no `role`, and that absence is the point of the row. The
 * acceptance payload is written by the invitee, so a role read from it is a
 * self-service privilege escalation with an audit trail that looks legitimate.
 * The role comes from the invitation the inviter created, and the only way to
 * express that here is for the request type not to have the field at all.
 */
export interface AcceptRequest {
  readonly token: string;
}

/**
 * Is this invitation addressed to this user?
 *
 * **Binding acceptance to the invited address is a deliberate cost.** Without
 * it, anyone holding the link is admitted — and links get forwarded, quoted in
 * tickets, and left in mailboxes that later change hands. With it, an invitee
 * who signed up under a different address cannot accept, and the fix is for the
 * owner to invite the address they actually use. That is a support message; the
 * alternative is a tenant joined by whoever opened the mail.
 *
 * Expiry is not checked here. The acceptance query filters on it while holding
 * the row lock, and duplicating the check in two places invites them to
 * disagree — the version that runs would then depend on which one the reader
 * happened to find.
 */
export const invitationIsFor = (
  invitation: { readonly email: string },
  user: { readonly email: string },
): boolean => normaliseAddress(invitation.email) === normaliseAddress(user.email);
