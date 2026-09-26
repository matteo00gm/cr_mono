# 0025. A secret key is hashed with SHA-256, not argon2id

Status: Accepted
Date: 2026-09-26

Rows: P0-25, P4-09, P4-10

## Context

The plan specified argon2id (memory ~64 MB, time cost 3) for `sk_live_` keys, in five places: the
data model, §3.4's integration options, §5's secrets section, P0-25's row and P4-09's.

argon2id is the right answer to a different question. A slow, memory-hard KDF exists to make a
**low-entropy** secret expensive to guess offline: a password somebody chose, of which there are
perhaps 2⁴⁰ plausible ones, where each guess costing 64 MB and a tenth of a second is the whole
defence. A `sk_live_` key is not that. It is 32 bytes from the CSPRNG — 2²⁵⁶ possibilities — and
nobody chose it. There is no dictionary to walk and no guess cheaper than any other. A leaked
SHA-256 of it is exactly as irreversible as a leaked argon2id of it, because the cost of reversing
either is set by the input's entropy, and the input's entropy is already beyond reach.

**The repository had already made this decision once, for exactly this input.** P0-51 hashes
invitation tokens with SHA-256 rather than argon2id, and its reasoning is this ADR's: "the token is
32 bytes from a CSPRNG, so there is no dictionary to attack and no low-entropy input to stretch."
Its comment went on to say that reasoning did _not_ transfer to `widget_keys`' secret — "the
difference is the entropy of the input". But P4-09 specifies that secret as 32 random bytes too.
There was no difference in entropy; there was an inconsistency in the plan, and the argon2id
requirement was the half of it that did not follow from the premises.

What argon2id _would_ change is the cost of verifying, and P4-10 is where that bites.

**The server-minted session endpoint verifies a secret key on every mint, and it accepts a bearer
token from anybody on the internet.** It is authenticated _by_ the key it is verifying, so until
the key verifies there is nobody to rate-limit but an address. Under argon2id each request with a
well-formed key forces 64 MB of allocation and a deliberately slow computation — a request that is
cheap for the caller and expensive for us is the definition of an amplification vector, and a
Lambda with 512 MB of memory serves eight of them at once before it starts failing.

It also forces a lookup design. A salted hash cannot be found by value: to verify a presented key
the server must first work out _which_ row to verify it against, which means either a second
identifier in the request or a scan. A deterministic hash is found by an indexed equality lookup
on the hash itself.

And it would have been the repository's first native dependency: argon2 for Node is either compiled
at install (node-gyp, a toolchain in the build image, and a binary that must match Lambda's
architecture) or downloaded prebuilt — a supply-chain surface on the one code path whose whole job
is to be trustworthy.

## Decision

**`secret_key_hash` is the hex SHA-256 of the full key, and it is looked up by equality.**

- Generation stays as specified: `sk_live_` followed by 32 bytes from `randomBytes`, base62. The
  entropy is what makes a fast hash sufficient, so it is not negotiable, and a test asserts it.
- A unique index on `secret_key_hash`. A presented key is hashed once and found in one indexed
  read, whatever row it belongs to and whether or not it belongs to any.
- The comparison is the index's equality check on a hash of a secret. It reveals nothing about the
  secret's bytes, so there is no timing oracle to close with `timingSafeEqual`.
- No pepper. A server-side pepper defends a low-entropy secret whose hash has leaked; a 256-bit
  random input needs no such help, and a pepper would be one more secret to manage, rotate and
  lose.

## Alternatives rejected

**argon2id as specified.** Buys no protection for a 256-bit input, costs 64 MB and a deliberate delay
per verification on an endpoint an unauthenticated caller drives, cannot be looked up by value, and
brings the first native dependency into the path that has to be the most trustworthy.

**argon2id with a lookup identifier.** Store a non-secret identifier beside the hash so the row can
be found, then run argon2id only against that row. Fixes the lookup, keeps the amplification — the
identifier is visible in the key, so an attacker who has one real key's prefix can make every
request cost a full KDF — and still protects nothing.

**HMAC-SHA256 with a server-side pepper.** A pepper defends a low-entropy secret whose hash has
leaked, by making the hash useless without a second secret. With 256 bits of input the hash is
already useless to an attacker, so the pepper protects nothing and adds a secret to provision,
rotate and — if it is ever lost — use to lock every seller out of their own integration.

**Storing the key encrypted rather than hashed.** Reversible by anybody holding the key, which is the
property this column exists not to have. A seller who loses their secret rotates it; there is no
case in which we should be able to tell them what it was.

## Consequences

- **A verification costs one hash and one indexed read**, on a path an unauthenticated caller
  drives. The rate limit per key (P4-10) is then about abuse, not about survival.
- **No native dependency.** `node:crypto` is the whole implementation.
- **The security of a stored hash now rests entirely on key generation.** A future change that
  produced keys with less entropy — a shorter random part, a human-chosen suffix, a key derived from
  something guessable — would quietly make this decision wrong. The generator's test is what stands
  between that change and a leaked table becoming a leaked set of keys, and it asserts the length
  and alphabet directly rather than trusting the implementation.
- If keys ever needed to be low-entropy — a key a human types — this ADR stops applying and a slow
  KDF is correct again. That would be a new ADR, not an edit to this one.

Every mention of argon2id in the plan is updated in the same PR, because a plan that says one
thing while the code does another teaches the next reader to trust neither.
