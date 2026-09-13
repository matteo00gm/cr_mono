# Changing the embedding model

A runbook for replacing Titan Text Embeddings V2 (1024 dimensions) with another model, one winery at a time, without any widget losing its recommendations while it happens. Written with P1-49; nobody has run it yet.

## Why not truncate and backfill

Retrieval reads `product_embeddings`. A wine with no vector is never recommended. Emptying the table and re-embedding the catalogue therefore takes every winery's recommendations down for as long as the backfill runs: hours, or days at scale. The cost of re-embedding is never the constraint (250,000 wines at Titan's price is well under a dollar). Wall-clock time and index build memory are.

## What makes it possible

| Piece                                                                                                                                                                  | Where                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Every vector carries a `version` (a smallint), and the unique key is `(tenant_id, product_id, chunk_idx, version)`, so two generations of a wine can sit side by side. | migration `0041_embedding_version`                          |
| Every tenant has `embedding_version`, the generation its retrieval reads.                                                                                              | `tenants.embedding_version`                                 |
| Retrieval filters on the pointer. Any query over `product_embeddings` must carry `activeEmbeddingVersionFilter(alias)`.                                                | `packages/db/src/embeddings.ts`, P2-18                      |
| The worker writes `CURRENT_EMBEDDING_VERSION` and compares against the stored hash of that version only.                                                               | `packages/db/src/embeddings.ts`, `apps/worker/src/embed.ts` |
| The cutover refuses while any active wine lacks a vector in the target generation.                                                                                     | `switchEmbeddingVersion`                                    |

## The procedure

1. **Decide whether the new model fits the column.** If it produces 1024-dimensional vectors, the new generation is just rows with `version = 2`, in the same `halfvec(1024)` column under the same HNSW index. If the dimension differs, the column cannot hold it (`halfvec(1024)` refuses any other length). That needs a migration adding a second embedding column or table, with its own HNSW index built with a transaction-local `maintenance_work_mem`, before anything below.
2. **Dual-write.** Deploy a worker that embeds every new and edited wine into both generations: the current provider at `version = 1`, the new one at `version = 2`. `upsertEmbedding` takes the version, and `readProductForEmbedding(tx, productId, version)` compares against that version's stored hash, so each generation decides on its own whether a wine needs work. Without dual-write, a wine edited during the backfill would be current in one generation and stale in the other.
3. **Backfill, per tenant.** Enqueue an embedding job for every active wine of one winery at a time, in background SQS batches, as P1-39's catalogue reindex already does. Watch the DLQ alarm; the P1-50 runbook covers what lands there.
4. **Cut over, per tenant.** Inside `withTenant(tenantId, …)`, call `switchEmbeddingVersion(tx, { tenantId, version: 2 })`.
   - It locks the tenant row, counts active wines with no `version = 2` vector, and refuses with `{ outcome: 'incomplete', missing }` while there are any. A winery is never served a partial index.
   - Archived wines don't count; they have no vector in either generation.
   - Switch a handful of wineries, watch their recommendations, then the rest.
5. **Keep generation 1 until generation 2 has proven itself.** Rolling back is the same call with `version: 1`. It succeeds as long as generation 1 still has a vector for every active wine, which dual-write keeps true. A wine edited since the switch may have a stale generation-1 vector; that still counts as present, deliberately, so ordinary editing can't block a rollback during the incident it is for.
6. **Clean up later, in its own migration.** Once no tenant points at generation 1, stop dual-writing, delete the `version = 1` rows, and advance `CURRENT_EMBEDDING_VERSION`. The down file of `0041` refuses to run while two generations exist, and that is intended: deciding which generation to drop belongs here, not in a rollback.

## Checks before calling it done

- `select embedding_version, count(*) from tenants group by 1` shows every tenant on the new generation.
- For each tenant, `switchEmbeddingVersion` to the version it is already on returns `switched`, which proves the set is complete.
- Recommendations for a sample of wineries look right to a person, not only to a query.
