# packages/eval

The golden Italian eval dataset and, from P1-46, the harness that scores pairing models against it. Test-time only.

## Invariants

- **Never import this package from production code.** It carries fixture catalogues and, from P1-46, a harness that seeds databases; `no-eval-in-production` in `.dependency-cruiser.mjs` refuses it (P1-45).
- **A label is a set of SKUs with a rationale.** Several wines are legitimately right for most questions, and a label without its argument cannot be challenged. Change a label only with its rationale (P1-45).
- **Labels name SKUs, never product ids.** The harness seeds a real database, and the database assigns the ids (P1-45).
- **An unanswerable query accepts nothing, and every other query accepts something.** An empty set anywhere else scores every honest "no" as correct for the wrong reason; `parseDataset` refuses it (P1-45).
- **Producers are fictional.** Denominations, grapes and regions are real, but invented tasting notes must never be attributed to a real winery (P1-45).
- **The dataset is validated on every load**, against the real product contract, so a wine that could not be seeded fails here rather than inside a bake-off run (P1-45).
