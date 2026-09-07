# 0014. Amazon Nova Lite by default, behind an LlmProvider port

Status: Accepted
Date: 2026-09-05

## Context

Model choice is the least stable decision in the product — pricing, capability and availability
all move — and it is also the largest variable cost.

## Decision

An `LlmProvider` port with Amazon Nova Lite on Bedrock as the default, and a configurable
escalation tier for the cases that need it.

## Consequences

Starting at the cheapest credible tier keeps the cost model honest, and the port means changing
it is configuration rather than surgery. Bedrock model access is granted per account and per
region, so availability in a region is necessary but not sufficient — it has to be requested.

## Alternatives rejected

**Committing to one vendor's SDK** makes the most volatile decision in the product the hardest
one to change.
