# 0033. Erasing a winery keeps its fiscal records, detached, and nothing else

Status: Accepted
Date: 2026-10-18

## Context

P7-08 erases a winery on request. Before it, every table with a `tenant_id` cascaded from
`tenants`, so deleting the row deleted everything — including `e_invoices`, the charges the
SdI bridge invoices (P5-03a).

Those charges are accounting records. Italian law requires invoices and the records behind them to
be kept for ten years (art. 2220 c.c.; art. 22 DPR 600/1973), and GDPR art. 17(3)(b) lets a legal
obligation outlast an erasure. A cascade that took them would make a winery's erasure the
destruction of our own books. A refusal to erase while any were held would make a winery
unerasable for a decade.

A charge names its buyer only through `tenant_id`: the name, P.IVA or codice fiscale, SdI code and
PEC address are on the `tenants` row, which is the thing being erased.

The runtime role cannot delete a winery (migration 0029), and the scripts are operator tools, not
routes — the self-serve buttons are deferred (§2.6).

The decision of what to keep was put to the user, who chose this one.

## Decision

**Erasure deletes everything a winery has except its charges, which are kept with the buyer's
identity copied onto them and the tie to the winery cut.** Migration 0079 gives `e_invoices` the
buyer's columns and `buyer_kept_at`, makes `tenant_id` nullable with `ON DELETE SET NULL`, and adds
a CHECK that a charge with no winery carries a buyer and the moment it was kept.

`eraseTenant` runs as the migration role in one transaction, scoped by `app.tenant_id` like any
other statement: refuses while a subscription is live or a charge is still owed an invoice, copies
the buyer onto the charges, deletes the `tenants` row and lets the cascades take the rest, deletes
member accounts that belonged to no other winery, and fails — undoing all of it — if any table with
a `tenant_id` still holds a row for the winery. Tables are found in the catalogue, not listed.

## Consequences

**The cost, stated first: a winery's billing identity outlives the winery, by design, for ten
years**, in rows no application path can reach — every policy compares `tenant_id` with a scope,
and null equals nothing. Reading one takes a role that bypasses row security. That is the point,
and it is also a second population of rows that only an operator can see.

**Nothing deletes them when the ten years are up.** The first are due in 2036; until a job does it,
the runbook does (`docs/runbooks/gdpr.md`).

**The CHECK makes the copy part of the erasure.** A bare `DELETE FROM tenants` on a winery with
charges now fails: the cascade would set `tenant_id` null on rows with no buyer. Anybody who erases
a winery any other way than `eraseTenant` has to copy the buyer first, or be refused.

**The winery's audit log goes with it**, so the erasure's record is a receipt file the script
writes and the operator keeps with the request. A row about the erasure in any table would be a row
that names the erased winery.

**The down migration refuses while a detached charge exists**, since reversing it would have to
either invent a winery for the charge or delete a record the law requires.

**Backups hold an erased winery for seven days**, and a restore brings it back: the runbook says to
re-run every erasure newer than the snapshot.

## Alternatives rejected

**Delete everything, charges included.** Simplest, and unlawful for us: the invoices are our
records, not only the winery's.

**Keep everything and mark the winery erased.** No personal data would leave; that is not an
erasure.

**Copy the charges into a separate archive table.** A second table with the same shape to keep in
step, and a second policy to get right, for rows that are already where an auditor would look. A
null `tenant_id` hides them as well as a new table would.

**Keep the `tenants` row, stripped to the billing fields.** Every scope, every list of wineries and
every count would have to learn to skip it, and a missed one is a winery that half exists.
