import { describeThreat } from './manifest.js';

/**
 * T3 — Poison the CORS allowlist with a lookalike domain (§3.0, P4-17).
 *
 * An origin is normalised by one authority, matched as an exact string, and admitted only after a DNS or file proof — so a lookalike cannot be added, and cannot be matched if it were.
 *
 * The evidence and its paths are in `threats.json`; this file is what a
 * reviewer opens to find them, and what fails if one goes missing.
 */
describeThreat('T3');
