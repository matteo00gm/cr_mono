# 0019. The invitation token is an RLS scope, not an exception to RLS

Status: Accepted
Date: 2026-09-06

## Context

Accepting an invitation is circular under tenant-scoped Row Level Security. The policy on every
tenant table reads `app.tenant_id`, which `withTenant` sets from a `memberships` row — but the
person accepting is not yet a member of the winery they are joining, and becoming one is exactly
what the request does. A tenant-scoped read of `invitations` therefore returns zero rows on the
one path that has to work.

ADR 0007 makes Postgres RLS the isolation boundary, and the standing rule (P0-19) is that no
query is issued outside a scope.

## Decision

A third scope, `withInvitation`, alongside `withTenant` (P0-19) and `withUser` (P0-47). It sets a
GUC holding the token's hash; the policy on `invitations` admits a row whose `token_hash` matches
it, in addition to the usual tenant branch. The tenant GUC is then set **from the matched row**,
inside the same transaction, so the membership write that follows is scoped by a value Postgres
produced.

## Consequences

The acceptance path stays entirely under RLS. Nothing about it needs an un-scoped connection, so
the sanctioned list of those does not grow — which matters because the value of one audited
escape hatch is that there is one.

The row is taken `FOR UPDATE`, which is what makes the token single-use under concurrency: two
simultaneous acceptances serialise, and the second re-reads a row that now carries `accepted_at`.

`WITH CHECK` stays tenant-only. The token branch admits reads and updates of a row you hold the
secret for; it does not let anybody insert an invitation into a tenant they do not belong to.

Adding a fourth scope should be treated as a design change rather than a configuration one. Each
GUC is another way a row can become visible, and the argument below only holds for values of this
particular kind.

## Alternatives rejected

**An un-scoped connection for the acceptance lookup**, as `@catalogorosso/db/auth` has for Better
Auth. It would put a second table outside RLS in order to solve a problem inside it, and the
connection would then exist for anything else to reach.

**Scoping by the accepting user's email** — a GUC holding the session's address, with a policy
admitting invitations sent to it. It works, and it makes "show me my pending invitations" a
natural query, but it widens the read from one row to every invitation ever addressed to that
person across all tenants. Revisit if a pending-invitations view is wanted.

**Nothing at all** — reading `invitations` inside `withTenant` and asking the invitee to be a
member first. That is not a workaround, it is the feature not existing.

## Why a token is safe here where a tenant id is not

The rule that tenant identity must never come from a request (P0-48) is about _identifiers_:
naming a tenant is not evidence of anything, so a request that names one is asserting something
it has no standing to assert. A 256-bit value from a CSPRNG is the opposite — holding it **is**
the authorization, in the same way a session cookie is. A caller who does not hold it matches no
row.
