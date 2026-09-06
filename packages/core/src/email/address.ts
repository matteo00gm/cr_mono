/**
 * Address normalisation (P0-64).
 *
 * One function, because a suppression list that stores `Bob@Example.com` and is
 * queried for `bob@example.com` suppresses nothing while looking like it does —
 * the most expensive shape of bug this module can have, since the symptom is
 * mail continuing to flow to a dead address and the domain reputation quietly
 * falling.
 */

/**
 * Lowercased and trimmed.
 *
 * **Only the domain is case-insensitive per RFC 5321**; the local part is
 * formally case-sensitive. Lowercasing both anyway is a deliberate call: every
 * mail provider a wine seller's customers actually use treats the local part
 * case-insensitively, and the alternative — `Bob@x.com` and `bob@x.com` as two
 * suppression rows — means half a suppression, which is no suppression.
 */
export const normaliseAddress = (address: string): string => address.trim().toLowerCase();

/**
 * A deliberately loose check: one `@`, something either side, no whitespace.
 *
 * Not an RFC 5322 grammar. Full-conformance regexes reject addresses that work
 * and accept ones that do not, and the authoritative test is whether the
 * provider delivers. What this catches is the class that is definitely a bug on
 * our side — an empty string, a template that interpolated `undefined`, a name
 * where an address should be — before it reaches the provider and counts
 * against the account.
 */
export const looksLikeAddress = (address: string): boolean => {
  const at = address.indexOf('@');
  return (
    at > 0 &&
    at === address.lastIndexOf('@') &&
    at < address.length - 1 &&
    !/[\s,;<>]/.test(address)
  );
};
