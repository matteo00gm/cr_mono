# Embedding failures and the DLQ

What to do when the `EmbeddingDlqDepth` alarm fires, or when a winery asks why a wine says _Non indicizzato_. Written with P1-50.

## What the alarm means

A message in the embedding dead-letter queue is a wine the worker tried three times and could not index, for a reason that was not the wine's own. Until somebody acts, that wine is missing from every recommendation. The alarm fires on a single message. A DLQ that fills quietly is indistinguishable from one with nothing to do.

Failures a seller can fix never reach the DLQ; they are recorded on the wine and acknowledged. So a message in the DLQ always has an operator-side cause.

## The reasons a wine can fail for

The worker stores a reason code in `products.embedding_error`. The API publishes it as `embeddingFailure`, and the catalogue grid shows the Italian sentence for it in the index-status tooltip.

| Code                  | Raised by                                                                                                                                                                                     | What happens to the message                                                    | What the seller sees                                                            | Who acts                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `input-rejected`      | The provider refusing the text (`ValidationException`)                                                                                                                                        | Recorded and acknowledged at once. Never retried, never the DLQ.               | The text was refused: check it and save. Saving re-queues the wine by itself.   | The seller                                               |
| `service-unavailable` | Throttling, a provider server error, an operator problem (credentials, permissions, a model not enabled, a quota), or anything that went wrong around the provider call, such as the database | Recorded and rethrown. SQS retries; after three deliveries it goes to the DLQ. | The service was unavailable; it will be retried; use «Reindicizza» if it stays. | Nobody, if it clears; an operator, if it reaches the DLQ |
| `unknown`             | A provider error nobody has classified yet                                                                                                                                                    | Retried on the first delivery, then recorded and acknowledged.                 | The reason is unknown; use «Reindicizza»; contact support if it repeats.        | An operator, to classify it                              |

Wines that failed before P1-50 store a provider error name, which publishes as `unknown`.

## Triage

1. **Read the worker's logs for the time the alarm fired.**
   - `embedding.failed` lines carry the provider's error name as `reason`.
   - `embedding.processed` lines with `outcome: "failed"` carry the stored code and the provider's name as `providerError`.
2. **Throttling** (`ThrottlingException`, `TooManyRequestsException`): usually a bulk import or a catalogue reindex. Check the Bedrock quota for Titan in `eu-west-1` before redriving, or the redrive throttles again.
3. **Credentials or permissions** (`AccessDeniedException`, `UnrecognizedClientException`, `ExpiredTokenException`, `ResourceNotFoundException`): a deploy changed the worker's role, or the model is not enabled for the account. Fix the configuration first.
4. **An outage** (`ServiceUnavailableException`, `InternalServerException`, `ModelTimeoutException`, or a database error): wait for it to clear.
5. **Many `unknown` failures** mean a provider error class the worker doesn't know. Add its name to the right set in `packages/core/src/rag/embedding-failure.ts`, with a test, then reindex the affected wines.

## Redrive

Once the cause is fixed, move the DLQ back to the queue:

```bash
pnpm build
```

```bash
EMBEDDING_DLQ_ARN=<dlq arn> EMBEDDING_QUEUE_ARN=<queue arn> node scripts/redrive-dlq.mjs
```

- **Where the ARNs come from.** Both are in the SST outputs for the stage (`EmbeddingDlq` and `EmbeddingQueue` in `infra/queue.ts`).
- **Credentials.** The script uses your shell's AWS credentials, and needs `sqs:ListMessageMoveTasks` and `sqs:StartMessageMoveTask` on the DLQ.
- **Safe to repeat.** It uses SQS's own message-move task, and running it while a move is under way starts nothing and reports progress instead. Redelivered messages are harmless too: the worker skips a wine whose vector is already current.
- **Checking it worked.** Watch the DLQ drain in the console, then confirm the alarm returns to OK. Wines that were `FAILED` show _Indicizzato_ again once the grid refreshes.

## A single wine, not the queue

When a seller reports one wine, open it in the catalogue.

- _Non indicizzato_ with the "testo rifiutato" sentence: the seller edits the text and saves.
- Any other sentence: «Reindicizza» on the row queues it again; it is P1-39's action and costs one provider call.
