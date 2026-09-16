/**
 * How long a revocation has to outlive its token (P2-14).
 *
 * A revocation refuses a token until the token can no longer be presented: its
 * expiry, plus the half hour a session continuation accepts after it (P2-12a).
 * The sweep's policy admits a revocation only once this has passed, and a test in
 * `apps/api` holds it to at least the continuation window, which lives there.
 *
 * A module of its own, importing nothing, because both the policy list and the
 * sweep statement read it.
 */
export const REVOCATION_SWEEP_GRACE_SEC = 30 * 60;
