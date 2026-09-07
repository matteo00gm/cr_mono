# 0017. Exact-set origin matching, never pattern matching

Status: Accepted
Date: 2026-09-05

## Context

The widget is embedded on sellers' own sites, so the API must accept cross-origin requests from
a list that each tenant controls. Origin checks are where this kind of feature goes wrong.

## Decision

An origin is allowed if and only if it is string-equal to a member of the tenant's stored set.
Never a regular expression, never `startsWith`, never `endsWith`, never a wildcard.

## Consequences

Sellers must register each origin exactly, including scheme and port, which is a small amount of
friction at setup. Stored origins are normalised — lowercase scheme and host, no path, no
trailing slash — and a database CHECK enforces that shape, so the comparison has one form to
compare against.

## Alternatives rejected

**Suffix matching** (`endsWith('.example.com')`) is defeated by `evil-example.com`.
**Regular expressions** are defeated by whichever metacharacter the author forgot to escape.
Both read as more flexible and are the standard way this control fails.
