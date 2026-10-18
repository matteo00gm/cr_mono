# Data requests: export and erasure

The self-serve buttons are deferred (§2.6); the obligation is not. This is how
a request is met by hand, with `scripts/tenant-export.mjs` and
`scripts/tenant-delete.mjs` (P7-08). What erasure keeps, and why, is
[ADR 0033](../adr/0033-erasing-a-winery-keeps-its-fiscal-records.md).

## Who is asking, and what we are to them

| Who                                  | We are                 | What they can ask of us                               |
| ------------------------------------ | ---------------------- | ----------------------------------------------------- |
| A winery, through its owner          | processor (§3.9)       | its data back; its account closed and its data erased |
| A member of a winery, about themself | controller             | their account's data; their account erased            |
| A shopper on a winery's site         | the winery's processor | nothing directly: the winery is their controller      |

**A shopper's request goes to the winery**, within two working days, and we
act on the winery's instruction and not the shopper's. A Shopify store's
customer requests arrive by webhook and are already answered (P6-09b). A
conversation names nobody: the widget sets no cookie, the privacy notice asks
shoppers not to write personal details (P3-23), and every transcript goes after
its winery's retention period (P7-07).

## Deadlines

GDPR art. 12(3): **one month from receipt**, extendable by two more for a
complex request — and the requester is told of the extension, with the reason,
inside the first month. Ours: acknowledged within three working days, done
within thirty. Start the clock on the day the request arrives, not the day it
is read.

## Who may run these

Only an operator who holds the production database credentials. The export
runs as the runtime role (`app_rw`); the erasure as the migration role
(`app_migrate`), because the runtime role cannot delete a winery (migration
0029). **The request must come from the winery's owner**: from the email
address of a member with the `OWNER` role on that winery, checked in
`memberships` — never a forwarded message, never another address that "speaks
for" them. When in doubt, ask them to confirm from inside the dashboard.

## Export

```bash
DATABASE_URL=<app_rw url> node scripts/tenant-export.mjs --tenant <tenant uuid>
```

Writes `exports/<tenant>-<date>/` (git ignores `exports/`): the winery, its
members, every table it has rows in as JSON and as CSV, and a `manifest.json`
saying what is there, what is not and why. Tables are found in the database's
catalogue rather than listed, so a table added later is in the next export
without anybody editing the script. Left out: embeddings (the products make
them again) and every credential — key hashes and pieces of keys, invitation
tokens, OAuth nonces, domain verification values. The export is recorded in
the winery's own audit log (`tenant.exported`, with a row count).

**Where it goes.** Zipped with a password, sent to the owner's sign-in address,
the password given by another channel. Never attached to a ticket, a chat or a
shared drive. Delete the local copy once the owner confirms receipt, and in any
case within thirty days.

## Erasure

In this order. Each step is a precondition of the next, and the script refuses
the ones it can check.

1. **Export first** and send it, unless the owner has said in writing they do
   not want it. It is the last time the data exists.
2. **Cancel the subscription in Stripe.** The webhook ends it here (P5-05); the
   script refuses while `stripe_subscription_id` is set.
3. **No charge still owed an invoice.** The script refuses while any
   `e_invoices` row is `pending`; issue those first (P5-03a).
4. **Dry run**, and read it:

   ```bash
   ERASURE_DATABASE_URL=<app_migrate url> node scripts/tenant-delete.mjs --tenant <tenant uuid>
   ```

   It prints the rows per table that would go, the charges that would be kept,
   the member accounts that would go with the winery and those kept because
   they belong to another winery too, and the Shopify shops still connected.

5. **Erase**, with `--execute`. It asks for the winery's slug to be typed and
   erases only on an exact match. One transaction: it either finishes, or
   leaves the winery as it was. It ends by checking that no table still holds
   a row for the winery, and fails — undoing everything — if one does.
6. **Remove each connected shop's token** the script names. Tokens live in SSM,
   not the database (ADR 0031), so the erasure cannot reach them:

   ```bash
   aws ssm delete-parameter --name /sommelier/<stage>/shopify/<tenant uuid>/<shop>
   ```

7. **Keep the receipt.** `exports/<tenant>-erasure-receipt.json` is the record
   of the erasure — the winery's own audit log went with it. File it with the
   request for as long as the charges are kept.
8. **Tell the owner** it is done, and what was kept.

### What is kept

**The charges, and the buyer's identity on them**: name, P.IVA or codice
fiscale, SdI code and PEC, copied onto each `e_invoices` row and detached from
the winery (`tenant_id` null, `buyer_kept_at` set). Italian law requires
accounting records and invoices to be kept for ten years (art. 2220 c.c.; art.
22 DPR 600/1973), and GDPR art. 17(3)(b) lets a legal obligation outlast an
erasure. Nothing else is kept: not the catalogue, not a transcript, not an
event, a key, a domain or a log row. Stripe keeps its own copy of the invoices
and the customer, for the same reason; nothing to do there.

**Detached charges are visible to no application path.** Every policy compares
`tenant_id` with a scope, and null equals nothing. To read one — for an audit,
or to answer the tax office — connect as a role that bypasses row security and
select by `buyer_vat_id`.

**⚠ Open: nothing deletes a charge after its ten years.** The first are due in
2036; until a job does it, it is this runbook's: delete `e_invoices` rows with
`tenant_id IS NULL AND buyer_kept_at < now() - interval '10 years'`.

### What is not reached

- **Backups.** Snapshots are kept seven days (`infra/database.ts`), so an
  erased winery is gone from them a week later. **After a restore, re-run
  every erasure whose receipt is newer than the snapshot** — a restore brings
  them back.
- **Logs** carry ids and counts and nothing a person wrote; the redaction
  allowlist (P0-56) sees to that. They age out with their log group.
- **Security events with no winery** — an attack on an unknown key, say. They
  hold an address bucket, an origin and a key's public half, no words and no
  identity, and are visible only to the admin role. Not purged yet
  (P7-07's open item); a winery's own security events go with it.

## A member's own request

An export is their row in `members.json` of any winery's export — id, name,
email, when they joined and their role, which is all we hold about a member
that is not a credential. An erasure is not scripted: the owner removes them
from each winery (or, if they are the last member of a winery, that is the
winery's erasure, above), and once they belong to no winery their
`auth_users` row is deleted as the migration role — sessions, accounts and
second factors go with it by cascade.
