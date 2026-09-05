# 0005. A static SPA for the dashboard, not server rendering

Status: Accepted
Date: 2026-09-05

## Context

The dashboard sits entirely behind a login. Nothing in it is indexable, and no visitor sees a
first paint that a crawler cares about.

## Decision

Vite plus Preact, built to static assets on S3 and served by CloudFront.

## Consequences

No server-side data fetching, so the first paint waits on an API round trip. For an
authenticated console that is an acceptable trade, and it removes an entire tier from the
deployment: there is no rendering server to run, patch, scale or pay for at idle.

## Alternatives rejected

**Next.js** buys SSR for SEO and first paint, neither of which applies behind a login, and adds
a server tier plus a framework whose rendering model would have to be reasoned about on every
page.
