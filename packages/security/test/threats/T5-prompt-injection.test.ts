import { describeThreat } from './manifest.js';

/**
 * T5 — Steer the model via product descriptions (§3.0, P4-17).
 *
 * Catalogue text reaches the model as delimited data, the system prompt never varies with it, and anything the model names is checked against what was retrieved.
 *
 * The evidence and its paths are in `threats.json`; this file is what a
 * reviewer opens to find them, and what fails if one goes missing.
 */
describeThreat('T5');
