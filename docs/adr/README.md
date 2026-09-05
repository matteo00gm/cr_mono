# Architecture Decision Records

One file per decision that would otherwise live in a pull-request comment and be
gone within a quarter.

## The rule that makes them worth keeping

**ADRs are append-only.** A decision that changes gets a _new_ ADR carrying
`Supersedes: NNNN`, and the old one's status becomes `Superseded by NNNN`. The
body of an accepted ADR is never edited.

That is not bureaucracy. Editing a decision to reflect the current one destroys
exactly the history the system exists for: somebody in a year needs to know not
just what we chose, but what we chose _before_, and what changed our minds. A
record that only ever shows the present state is a record of nothing.

`scripts/check-adrs.mjs` enforces the consequences of that rule on every CI run
— numbering has no gaps (a gap means a decision was deleted), every supersession
resolves, and both halves of one are present. The rule itself is enforced by
review and by git history.

## Writing one

Copy `0000-template.md`, take the next number, never reuse one. Four sections,
all required: Context, Decision, Consequences, Alternatives rejected.

The two that get skipped are the two that matter. **Consequences** must include
what the decision _costs_ — a decision with no listed cost has not been thought
about. **Alternatives rejected** is what stops the same argument being had again.

## Where the rest of the documentation lives

`plan-v1.md` at the repository root remains the build plan and the source of
truth for task specifications, as-built deviations and open items. These ADRs
record the standing decisions that plan rests on; they do not replace it.
