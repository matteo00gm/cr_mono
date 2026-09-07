# 0016. eu-west-1 as the single region

Status: Accepted
Date: 2026-09-05

## Context

Three constraints bind at once: EU data residency for sellers' customer data, availability of
the Bedrock models this product depends on, and cost.

## Decision

Everything runs in `eu-west-1` (Ireland).

## Consequences

One region means no cross-region replication to reason about and no multi-region failover — an
outage there is an outage here. That is the accepted trade at this scale.

`eu-south-1` (Milan) is nearer to the initial users and was rejected: it is pricier, with
thinner service coverage and less certain model availability.

## Alternatives rejected

**A US region** fails the residency requirement outright. **Multi-region** buys availability
nobody is paying for yet and costs a replication topology to design, run and test.
