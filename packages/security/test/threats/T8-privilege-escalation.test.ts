import { describeThreat } from './manifest.js';

/**
 * T8 — Escalate `EDITOR` → `OWNER`, or act with no membership at all (§3.0, P4-17).
 *
 * Every dashboard route declares a capability, a generated matrix calls every route as every role, and the routes that change who can act need a fresh second factor.
 *
 * The evidence and its paths are in `threats.json`; this file is what a
 * reviewer opens to find them, and what fails if one goes missing.
 */
describeThreat('T8');
