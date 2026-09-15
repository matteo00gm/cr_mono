import { createHmac } from 'node:crypto';

/**
 * A visitor's address as a rate-limit bucket key, never the address (P2-04).
 *
 * **An HMAC, not a hash.** IPv4 is a space of four billion values, so a plain
 * SHA-256 of an address is reversed by enumerating them — the table would hold
 * personal data in a costume. Keyed with a secret, the bucket cannot be turned
 * back into an address by anyone who reads `rate_limit_buckets`, and a bucket
 * key is no reason to retain one.
 *
 * **The salt rotates daily**, derived from the secret and the UTC date rather
 * than stored anywhere, so yesterday's buckets stop linking to today's visitor.
 * The cost is that an address's per-minute count restarts at midnight UTC,
 * which is one extra minute of allowance once a day.
 *
 * An unresolvable address shares one bucket per tenant and endpoint. Behind
 * CloudFront that cannot happen — the viewer-IP function always sets exactly
 * one entry (A2) — and locally there is only one visitor anyway.
 *
 * **Here rather than beside the dimensions in `packages/security`**, because
 * that package is imported by the dashboard's browser bundle and this needs
 * `node:crypto`. The API is the only thing that ever buckets an address.
 */
export const bucketIp = (ip: string | undefined, secret: string, nowMs: number): string => {
  if (secret.trim() === '') {
    throw new Error(
      'bucketIp: an empty secret makes every address bucket reversible by enumerating addresses.',
    );
  }

  const day = new Date(nowMs).toISOString().slice(0, 10);
  const salt = createHmac('sha256', secret).update(`widget-ip-bucket:${day}`).digest();

  return createHmac('sha256', salt)
    .update(ip ?? 'unknown')
    .digest('hex')
    .slice(0, 32);
};
