import { createHash } from 'node:crypto';

import { embeddingText, EMBEDDING_TEXT_VERSION, type EmbeddableProduct } from './embedding-text.js';

/**
 * What an edit costs (P1-34, decided early by P1-02).
 *
 * **The hash is over the embedding text itself**, which is what makes it
 * meaningful rather than merely stable: two products with the same hash produce
 * the same document, so re-embedding one of them cannot produce a different
 * vector. A hash over some *other* projection of the row would be a value that
 * usually agrees with the text and occasionally does not — and the failure
 * would be a wine described by an embedding of its previous description, with
 * nothing failing.
 */

/**
 * A stable hash of everything the embedding depends on.
 *
 * Same value for the same content forever, across processes and deploys — so a
 * product re-imported unchanged next year still costs nothing. That rules out
 * anything seeded per process, which is the trap: a `Map` keyed on object
 * identity, or a hash of `JSON.stringify(product)` with its key order, would
 * both "work" in a test and re-embed the catalogue on every deploy.
 *
 * The version is inside the hash rather than beside it, so a rendering change
 * cannot leave a catalogue half-embedded under two schemes.
 */
export const contentHashOf = (product: EmbeddableProduct): string =>
  createHash('sha256')
    .update(`${EMBEDDING_TEXT_VERSION}\n${embeddingText(product)}`)
    .digest('hex');

/**
 * Whether the worker should call the provider at all (P1-34).
 *
 * **Belt and braces with the endpoint's own check.** P1-03 already avoids
 * enqueueing when the hash did not move; this is the second half, and it earns
 * its place because the two protect against different things. The endpoint
 * stops ordinary edits costing money. This stops a *redelivered* message, a
 * manual reindex of an unchanged product, and any future path that enqueues
 * without thinking — and the provider call is the part that costs.
 *
 * `undefined` for the stored hash means the row has never been embedded, which
 * is not the same as "unchanged": it must embed.
 */
export const shouldEmbed = (productHash: string, storedHash: string | null | undefined): boolean =>
  storedHash === null || storedHash === undefined || storedHash !== productHash;
