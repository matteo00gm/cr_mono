# Documentation

| Where                            | What                                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| [`adr/`](adr/)                   | Architecture Decision Records — the standing decisions, append-only  |
| [`../plan-v1.md`](../plan-v1.md) | The build plan: task specifications, as-built deviations, open items |

## Which one to write in

A **decision** with alternatives that were considered and rejected is an ADR.
It is standing, it outlives the task that prompted it, and changing it means
writing a new one rather than editing the old.

A **deviation** — the spec said X, the code does Y, here is why — belongs in the
plan, next to the task it belongs to. So does an open item.

The distinction that matters: an ADR answers _"why is it like this?"_ for
somebody who has never seen the task. The plan answers _"what happened while
building it?"_ Both are needed; neither substitutes for the other.
