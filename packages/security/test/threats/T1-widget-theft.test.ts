import { describeThreat } from './manifest.js';

/**
 * T1 — Embed a stolen `pk_` on their own site (§3.0, P4-17).
 *
 * A stolen public key is useless off the origins its winery verified: the server checks `Origin` against an exact set, every origin belongs to one winery, and a session token is bound to the origin it was minted for.
 *
 * The evidence and its paths are in `threats.json`; this file is what a
 * reviewer opens to find them, and what fails if one goes missing.
 */
describeThreat('T1');
