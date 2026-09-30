import { describeThreat } from './manifest.js';

/**
 * T10 — Exfiltrate a tenant's data via a hallucinated SKU (§3.0, P4-17).
 *
 * Retrieval sees one winery's catalogue, the model's picks are cut to this turn's candidates, and every field a card shows comes from the catalogue.
 *
 * The evidence and its paths are in `threats.json`; this file is what a
 * reviewer opens to find them, and what fails if one goes missing.
 */
describeThreat('T10');
