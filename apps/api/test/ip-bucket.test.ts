import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { bucketIp } from '../src/middleware/ip-bucket.js';

/**
 * The address as a bucket key (P2-04).
 *
 * The property that matters is the one nobody sees go wrong: a key that could
 * be turned back into an address means `rate_limit_buckets` quietly holds
 * personal data. These assert it cannot, that one address stays one bucket for
 * a day, and that the day's salt really does rotate.
 */

describe('bucketIp', () => {
  const secret = randomUUID();
  const noon = Date.UTC(2026, 8, 15, 12);

  it('never contains the address, and is a fixed-length hex digest', () => {
    const bucket = bucketIp('198.51.100.42', secret, noon);

    expect(bucket).toMatch(/^[0-9a-f]{32}$/);
    expect(bucket).not.toContain('198.51.100.42');
  });

  it('is stable for one address within a UTC day', () => {
    expect(bucketIp('198.51.100.42', secret, Date.UTC(2026, 8, 15, 0, 0))).toBe(
      bucketIp('198.51.100.42', secret, Date.UTC(2026, 8, 15, 23, 59, 59, 999)),
    );
  });

  it('rotates at midnight UTC, so yesterday no longer links to today', () => {
    expect(bucketIp('198.51.100.42', secret, Date.UTC(2026, 8, 15, 23, 59, 59, 999))).not.toBe(
      bucketIp('198.51.100.42', secret, Date.UTC(2026, 8, 16, 0, 0)),
    );
  });

  it('differs by address and by secret', () => {
    const bucket = bucketIp('198.51.100.42', secret, noon);

    expect(bucketIp('198.51.100.43', secret, noon)).not.toBe(bucket);
    expect(bucketIp('198.51.100.42', randomUUID(), noon)).not.toBe(bucket);
  });

  it('puts an unresolvable address in one shared bucket rather than failing', () => {
    expect(bucketIp(undefined, secret, noon)).toBe(bucketIp(undefined, secret, noon));
    expect(bucketIp(undefined, secret, noon)).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each(['', '   '])('refuses a secret of %j', (empty) => {
    // An empty key is a plain hash, and four billion IPv4 addresses reverse it.
    expect(() => bucketIp('198.51.100.42', empty, noon)).toThrow(/empty secret/);
  });
});
