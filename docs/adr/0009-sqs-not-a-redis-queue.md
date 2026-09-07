# 0009. SQS for background work

Status: Accepted
Date: 2026-09-05

## Context

Embedding, catalogue sync, webhook handling and usage rollups all need to happen off the request
path. The traffic is bursty and the baseline is near zero.

## Decision

Amazon SQS, with Lambda event source mappings, retries and a dead-letter queue.

## Consequences

On-demand pricing means no idle cost, and retries plus the DLQ come for free rather than being
written. The constraint it brings is subtle and documented in P1-42: with an SQS event source,
_reserved_ concurrency throttles invocations rather than slowing polling, so throttled messages
return to the queue, increment their receive count, and land in the DLQ looking like failures
they never were. Bound worker concurrency with `MaximumConcurrency` instead.

## Alternatives rejected

**BullMQ** means paying for Redis capacity to do what SQS does for cents, and adds a component
to run and secure.
