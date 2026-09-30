import { describeThreat } from './manifest.js';

/**
 * T4 — Burn a competitor's message quota (§3.0, P4-17).
 *
 * Every widget request draws several allowances at once, and a chat past the month's cap is refused before a model is built or called.
 *
 * The evidence and its paths are in `threats.json`; this file is what a
 * reviewer opens to find them, and what fails if one goes missing.
 */
describeThreat('T4');
