# 0011. halfvec(1024) embeddings with an HNSW index

Status: Accepted
Date: 2026-09-05

## Context

Vector index memory is what dictates the RDS instance size, and the instance size is the largest
single line in the cost model.

## Decision

Embeddings are stored as `halfvec(1024)` — 16-bit floats at 1024 dimensions — indexed with HNSW.

## Consequences

2 KB per vector against 6 KB for `vector(1536)`: a threefold cut in the memory that decides the
instance class. Recall loss at 16-bit is negligible for this workload.

It pins a floor on the pgvector version — `halfvec` needs 0.7.0 — which is why the test
container is pinned to `pgvector/pgvector:0.8.0-pg16`, matching what RDS actually offers, and
pinned _low_ rather than newest so a capability that works in tests works in production.

## Alternatives rejected

**`vector(1536)`** is the default shape for many embedding models and costs three times the
index memory. **A dedicated vector database** adds a second datastore to run, back up and
secure, and splits the transactional and vector data that this product queries together.
