import { describeThreat } from './manifest.js';

/**
 * T2 — Read another tenant's catalog via the API (§3.0, P4-17).
 *
 * Row-level security is the isolation boundary, the tenant comes from a membership and never from the request, and every id route answers another winery's id exactly as it answers a missing one.
 *
 * The evidence and its paths are in `threats.json`; this file is what a
 * reviewer opens to find them, and what fails if one goes missing.
 */
describeThreat('T2');
