# 0001. TypeScript across every runtime

Status: Accepted
Date: 2026-09-05

## Context

Four runtimes ship in this product — an embeddable widget, a dashboard SPA, an HTTP API and a
queue worker — and the team building them is very small. Any language boundary between them
means contract types are regenerated rather than shared, two test runners, two CI paths, and a
second set of idioms to keep in one head.

## Decision

Every runtime is TypeScript, in one pnpm workspace, with `strict` plus
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on from the first commit.

## Consequences

Node's cold starts are worse than Go's, and the JS ecosystem demands more dependency hygiene —
hence the P0-08 audit gate and Renovate. The strictness flags cost real time early: they are far
cheaper to switch on before there is code than after.

What it buys is that a request shape is _one_ type, from the Drizzle table through the API to
the widget, and a change to it fails at compile time in all three.

## Alternatives rejected

**Go for the API** was priced at roughly four dollars a month cheaper and rejected: it loses the
shared contract types across three consumers, loses first-class Lambda response streaming (Go
needs a custom runtime or the Lambda Web Adapter), and adds a second toolchain to a team that
cannot afford one. Four dollars is not a reason to double the surface area.
