# 0010. Rate limits in Postgres, behind an interface

Status: Accepted
Date: 2026-09-05

## Context

Rate limiting and token revocation both need shared, durable counters. The obvious answer is
Redis, and the obvious answer has a floor price.

## Decision

A `RateLimiter` interface with a Postgres implementation — a token bucket via
`INSERT … ON CONFLICT DO UPDATE … RETURNING`. No Redis or Valkey until there is a measured need.

## Consequences

ElastiCache Serverless for Valkey has a 100 MB floor at roughly $6.13 a month, about 22% of the
month-one bill, for a component that measurably does nothing at two tenants. The interface and
its concurrency test suite are written once and shared, so a Valkey adapter later is roughly
fifty lines validated by tests that already exist.

The counter-argument — that a rate limiter is a security control one would rather not rewrite —
is fair, and is answered by the shared test suite rather than by paying for the component early.

## Alternatives rejected

**Redis or Valkey from day zero** costs $74 a year pre-revenue to avoid fifty lines of code
written against tests that exist either way.
