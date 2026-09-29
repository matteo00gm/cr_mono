# 0028. A proven domain claim is an eighth RLS scope, and it reaches one row

Status: Accepted
Date: 2026-09-29

Rows: P4-18, P4-01, P4-06, P4-07

## Context

`UNIQUE(origin)` on `tenant_domains` is the anti-sharing backbone (§3.2): an origin belongs to one
winery, and the database says so. It also turns ordinary business events into dead ends. A winery
churns and abandons its account; the business is sold; an agency rebuilds the site under a new
workspace. The new owner adds the domain, and P4-01 answers "not available" — correctly, because
saying who holds it would make that route an oracle for enumerating our customers. Until now the
only way out was one of us running SQL.

P4-18 lets the new owner prove control of the zone with the same `_somm-verify` TXT record a first
verification takes, and then settles the claim: an abandoned, unpaid or never-verified holding
moves at once, and a paying holder is put on 72 hours' notice first.

Settling needs two things RLS exists to prevent. The claimant's request has to **read another
winery's domain row**, to learn who holds the origin and whether that winery is paying. And it has
to **write in two wineries in one transaction**: the holder's row deleted, its sessions cut off
(P4-06) and its audit log written; the claimant's row inserted and its audit log written. A
settlement that committed half of that would hand the origin to nobody, or to two wineries at once.

## Decision

An eighth scope, `settleDomainClaim`, bounded in the policy by the claim and in the code by what
the scope does.

- **One GUC, `app.domain_claim`, and one policy branch, on `tenant_domains` alone.** The branch
  admits the domain whose origin a _settleable_ claim names: a claim visible to the tenant that is
  set, whose status is `PROVEN`, or `NOTICE` with `transfer_at <= now()`. The claim is read under
  `domain_claims`' own policy, so naming somebody else's claim opens nothing, and so does naming a
  claim with no tenant set. A claim still waiting for its TXT record, a notice with time left and a
  withdrawn claim admit nothing. **The 72-hour deadline is enforced by the database**, not by
  whoever calls the settlement.
- **It reads the holder and then stops being itself.** The GUC is set for one `SELECT ... FOR
UPDATE` of the holder's row and cleared in the next statement, which also moves `app.tenant_id`
  to the holder. The holder's status, the delete, the cutoff and the holder's audit row all run
  under the holder's ordinary tenant policy. Then `app.tenant_id` moves back to the claimant for the
  claimant's row and audit row.
- **Read-write, unlike ADR 0022's and ADR 0026's scopes.** A settlement writes. So what bounds the
  branch is weaker than a read-only transaction, and the ADR says so: Postgres applies a policy's
  `USING` to the rows an `UPDATE` or `DELETE` can reach, so while the GUC is set the claimant could
  _delete_ the holder's row, not only read it. `WITH CHECK` stays tenant-only, so an `UPDATE`
  cannot write it. The deletion is prevented by the code: the scope is **a closed operation, not a
  callback**. `withTenant` hands its caller a transaction; this does not, so nothing runs inside the
  widened branch except the one statement written in `with-domain-claim.ts`, and a unit test checks
  that the next statement clears the GUC.
- **Two tenants on one `domain_claims` row.** The claimant owns it as `tenant_id`. The holder must
  see a notice served on it, so `incumbent_tenant_id` admits it too, and is set only with the
  notice. The holder's half of `WITH CHECK` admits only a `CANCELED` row: a holder can withdraw a
  claim, and cannot write a live one, least of all one naming somebody else as claimant. Every
  claimant statement names the claimant's tenant explicitly as well, because a holder must not act
  on a claim through the claimant's routes. The IDOR matrix (P4-15) seeds that exact case.
- **Refused inside `withTenant`**, as every scope since ADR 0022 is. This one moves
  `app.tenant_id` between two wineries, and a caller holding a transaction open on one of them
  would be reading under whichever it happened to be set to.
- **Neither side is named to the other.** The claimant is never told who held the origin. The
  holder's audit row carries no actor, because the actor is a member of another winery. The claim
  shapes on the wire leave out `incumbent_tenant_id`.

## Alternatives rejected

**Do it as `app_admin`.** The role bypasses RLS. That would duplicate the one sanctioned un-scoped
path into tenant data on a route any owner can call, which CLAUDE.md forbids in so many words.

**A branch that admits the holder's row by origin alone.** It would make every origin's holder
readable to anybody who could set the GUC, and there would be nothing in the database recording
that the DNS proof happened. Tying the branch to a claim in `PROVEN` means the database is what
knows a proof was recorded: only the claimant's own tenant-scoped write, after the TXT record was
found, moves a claim there.

**Two transactions, one per winery.** The first would delete the holder's row; the second would
insert the claimant's. A failure between them leaves the origin with nobody, and a second claimant
settling at the same moment could take it in the gap. The plan asks for one transaction, and this
is the reason.

**Transfer on proof, whoever the holder is.** A hostile contractor, a compromised registrar or a
misconfigured shared zone can all produce a valid TXT record. Moving a paying customer's origin on
that alone kills a live widget with nobody told. The notice is the safeguard, and the deadline
being in the policy is what makes it one.

## Consequences

- Eight scopes. This one reaches a single `tenant_domains` row, of one origin, for one statement,
  and only behind a claim the database has recorded as proven or as past its notice.
- **The claimant learns one thing about the holder**: whether the origin moved at once or after a
  notice, which tells them whether the holder was paying. The flow cannot hide it, because a seller
  has to be told when the domain will be theirs. Nothing else about the holder is disclosed.
- Every query on `tenant_domains` now evaluates one more `OR` branch. With the GUC unset, the
  subquery matches no claim.
- P4-18b's holder view and withdrawal need no further policy change: they use the policy's holder
  half. **Its sweep does need one.** Settling a due notice goes through this same scope, but
  _finding_ the due notices is a read across every winery's claims, and nothing here admits that.
  P4-18b will add a flag-guarded branch on `domain_claims` that admits only `NOTICE` rows past
  `transfer_at`, on ADR 0023's pattern, and record it as an amendment to this ADR.
