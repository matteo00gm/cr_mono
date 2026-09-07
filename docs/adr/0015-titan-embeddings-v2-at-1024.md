# 0015. Titan Text Embeddings V2 at 1024 dimensions

Status: Accepted
Date: 2026-09-05

## Context

The embedding model has to cover Italian and English at least, and its output dimension decides
the vector index size, which decides the instance class.

## Decision

`amazon.titan-embed-text-v2:0`, requested at 1024 dimensions with `normalize: true`.

## Consequences

Native Matryoshka output at 1024/512/256 means the dimension is a choice rather than a
constraint, and 1024 is what makes `halfvec(1024)` viable. Normalising at the source makes
cosine distance equivalent to inner product and keeps magnitudes consistent.

Titan embeds one text per call, so batching is our problem: bounded concurrency, jittered
backoff on throttling, and truncation at a sentence boundary above the 8,192-token limit.

## Alternatives rejected

**OpenAI's embedding models** are a second vendor relationship and a second egress path for text
that has already been decided to stay inside one cloud.
