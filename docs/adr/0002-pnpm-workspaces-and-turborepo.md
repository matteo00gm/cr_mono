# 0002. pnpm workspaces with Turborepo

Status: Accepted
Date: 2026-09-05

## Context

One repository holds eight packages that depend on each other in one direction only. Nothing in
npm or yarn's default hoisting stops a package importing something it never declared, and that
kind of accidental coupling is invisible until the day a package is extracted.

## Decision

pnpm workspaces for linking, Turborepo for task orchestration.

## Consequences

pnpm's strict linking occasionally surprises: a package must declare what it imports, including
types, or resolution fails. That is the feature working. Turborepo adds one file and a cache
that has, at least once, hidden a broken intermediate commit by serving a stale typecheck
result — see the note on cold caches in the plan's open items.

## Alternatives rejected

**npm or yarn workspaces** hoist by default, so the boundary this repository depends on would
not exist. **Nx** does more than is needed here and asks for more configuration than thirty
lines of `turbo.json`.
