import { streamHandle } from 'hono/aws-lambda';

import { createApp } from './app.js';
import { dependencies } from './index.js';

/**
 * The streaming entry point (P2-29, §5.1).
 *
 * **A second function, not a second route.** `RESPONSE_STREAM` is a property of
 * the *function*: a Lambda is buffered or it streams, and the API is buffered
 * on purpose — every other route answers with a small JSON body, and streaming
 * one of those would cost a warm connection for no benefit. So the chat path
 * gets its own function, its own Function URL and its own CloudFront origin,
 * and this file is the entry it runs.
 *
 * **The same app, built the same way.** Both functions register the same routes
 * from the same composition root, so a guard added to the widget surface
 * applies to both without anybody remembering. What differs is one line: how
 * the response leaves.
 */
/*
 * Annotated rather than inferred: the inferred type names a Hono internal path
 * (`dist/types/adapter/aws-lambda/types.js`) that a declaration file cannot
 * portably reference, which is TS2742. What Lambda needs is the shape below.
 */
export const handler: (event: unknown, responseStream: unknown, context: unknown) => Promise<void> =
  streamHandle(createApp(dependencies)) as never;
