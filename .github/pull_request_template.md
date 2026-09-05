## Why

<!--
  Required. CI fails if this is empty or still holds this comment.

  `git log` will answer *what* changed forever. Only this section will answer
  *why*, and only if it is written while you still remember — asked in six
  months, nobody reconstructs it accurately.

  What forced the change? What breaks without it? If you found something the
  specification did not anticipate, this is where it goes.
-->

## What changed

<!-- The shape of the change. A reviewer reads this before the diff. -->

## How to verify

<!--
  What you actually ran, and what it said. "Tests pass" is not verification —
  CI says that. This is for the thing CI cannot: the container you drove by
  hand, the guard you broke on purpose to watch it fire, the deployed request
  you made.
-->

## Checklist

- [ ] Task: `P0-NN` <!-- or `n/a` with a reason -->
- [ ] Plan updated in this PR where implementation departs from the spec, with the reason
- [ ] Any new guard has been broken on purpose to confirm it fires
- [ ] **If this contradicts an existing ADR, the superseding ADR is written and linked below.**
      Not automatable, and a reviewer's responsibility: a decision changed by a
      pull request and not by an ADR is a decision that quietly stops being
      findable. See `docs/adr/README.md` — ADRs are append-only.
