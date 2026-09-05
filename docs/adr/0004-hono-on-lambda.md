# 0004. Hono on Lambda, not a batteries-included framework

Status: Accepted
Date: 2026-09-05

## Context

The API is serverless and cost-sensitive, and its middleware — tenant resolution, capability
checks — is the security boundary of the product. Whatever framework runs it has to cold-start
cheaply and has to make that middleware easy to unit-test.

## Decision

Hono on AWS Lambda, arm64, behind CloudFront and Function URLs.

## Consequences

Hono is small enough that its behaviour has to be read from source rather than assumed, and that
has already mattered twice: it matches handlers in _registration order_, so a guard registered
below the route it guards silently never runs; and it rethrows a thrown non-`Error` instead of
calling `onError`, so such a value escapes the application entirely. Both are now pinned by
tests (P0-54, P0-55).

## Alternatives rejected

**NestJS** costs one to two seconds of DI bootstrap and about a gigabyte on Lambda, and its
guards are harder to unit-test than plain functions. **Express** is neither small nor
Fetch-native, and the Fetch API is what makes the Better Auth handler mount without an adapter.
