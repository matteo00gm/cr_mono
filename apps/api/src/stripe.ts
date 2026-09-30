import { encodeStripeForm, STRIPE_API_VERSION, type StripeParams } from '@catalogorosso/core';
import type { z } from 'zod';

/**
 * The API's Stripe client (P5-02).
 *
 * **Two verbs and a schema, and no SDK.** The API calls a handful of endpoints —
 * prices by lookup key, Checkout and Billing Portal sessions, subscriptions —
 * and every response is parsed with a Zod schema naming only the fields we
 * read, so a field Stripe renames fails loudly here rather than as `undefined`
 * three calls later. The SDK would bring every other endpoint's types and a
 * second idea of the API version; this pins one (`STRIPE_API_VERSION`) and
 * encodes with the same function as the setup script.
 *
 * Not `guardedFetch`: that is for hosts a user supplies (P4-03a), and this one
 * is a constant.
 */

export interface StripeClient {
  readonly get: <T>(path: string, params: StripeParams, schema: z.ZodType<T>) => Promise<T>;
  readonly post: <T>(
    path: string,
    params: StripeParams,
    schema: z.ZodType<T>,
    options?: { readonly idempotencyKey?: string | undefined },
  ) => Promise<T>;
}

/**
 * Stripe refused, answered something we cannot read, or did not answer.
 *
 * **Not a `DomainError`, so its message never reaches a caller** (P0-55): it
 * names Stripe's error type and code for the log, and a seller sees the
 * generic 500. Stripe's own `message` is left out entirely — it can quote a
 * customer's email or a card's last four back at us, and none of that belongs
 * in a log line either.
 */
export class StripeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | undefined,
    readonly code: string | undefined,
    description: string,
    options?: { cause?: unknown },
  ) {
    super(description, options);
    this.name = 'StripeRequestError';
  }
}

export interface StripeClientOptions {
  readonly secretKey: string;
  readonly fetch?: typeof fetch | undefined;
  /** Stripe's origin. Overridden only by tests. */
  readonly base?: string | undefined;
  /** Past this, a call is abandoned rather than holding the request open. */
  readonly timeoutMs?: number | undefined;
}

interface StripeErrorBody {
  readonly error?: { readonly type?: string; readonly code?: string };
}

export const createStripeClient = ({
  secretKey,
  fetch: fetch_ = globalThis.fetch,
  base = 'https://api.stripe.com',
  timeoutMs = 10_000,
}: StripeClientOptions): StripeClient => {
  const call = async <T>(
    method: 'GET' | 'POST',
    path: string,
    params: StripeParams,
    schema: z.ZodType<T>,
    idempotencyKey?: string,
  ): Promise<T> => {
    const form = new URLSearchParams(encodeStripeForm(params)).toString();
    const headers: Record<string, string> = {
      authorization: `Bearer ${secretKey}`,
      'stripe-version': STRIPE_API_VERSION,
    };

    if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;

    let response: Response;

    try {
      response = await fetch_(
        method === 'GET' && form !== '' ? `${base}${path}?${form}` : `${base}${path}`,
        {
          method,
          headers,
          ...(method === 'POST' ? { body: form } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      throw new StripeRequestError(0, undefined, undefined, `${method} ${path}: no response`, {
        cause: error,
      });
    }

    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const { type, code } = (body as StripeErrorBody | undefined)?.error ?? {};

      throw new StripeRequestError(
        response.status,
        type,
        code,
        `${method} ${path}: HTTP ${String(response.status)}`,
      );
    }

    const parsed = schema.safeParse(body);

    if (!parsed.success) {
      throw new StripeRequestError(
        response.status,
        undefined,
        undefined,
        `${method} ${path}: a response we cannot read`,
        { cause: parsed.error },
      );
    }

    return parsed.data;
  };

  return {
    get: (path, params, schema) => call('GET', path, params, schema),
    post: (path, params, schema, options) =>
      call('POST', path, params, schema, options?.idempotencyKey),
  };
};
