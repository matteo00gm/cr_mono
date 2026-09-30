import { describeThreat } from './manifest.js';

/**
 * T9 — Replay a captured session token (§3.0, P4-17).
 *
 * A session token is short-lived, signed, bound to its origin, and refused once its `jti` or its origin's cutoff says so.
 *
 * The evidence and its paths are in `threats.json`; this file is what a
 * reviewer opens to find them, and what fails if one goes missing.
 */
describeThreat('T9');
