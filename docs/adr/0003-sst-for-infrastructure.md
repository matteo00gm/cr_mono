# 0003. SST for infrastructure

Status: Accepted
Date: 2026-09-05

## Context

The stack is CloudFront in front of Lambda Function URLs, RDS in private subnets, SQS, and a
static site with cache invalidation. Wiring that by hand is where the errors live —
`RESPONSE_STREAM` invoke modes, origin request policies, subnet groups — and each one fails in a
way that looks like an application bug.

## Decision

SST v4, pinned to an exact version, with every option checked against that version's source
rather than against documentation.

## Consequences

SST's v3 line moved from CloudFormation to Pulumi and v4 continued it, so the framework has
churn history. That is why the version is pinned exactly and why defaults are verified from
source: three of them differed from what the plan assumed in P0-54 alone —
`architecture`, `runtime` and `memory` — and each would have been wrong quietly.

`sst dev` runs local code against real AWS events, which is the single biggest day-to-day
factor for a Lambda application and is not replicable with raw CDK.

## Alternatives rejected

**Raw CDK or Terraform** would be three to five hundred lines against SST's hundred, and would
own the same error-prone wiring by hand. The escape hatch to raw resources exists in SST, so
nothing is actually foreclosed.
