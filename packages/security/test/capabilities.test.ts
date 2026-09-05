import { describe, expect, it } from 'vitest';

import {
  ALL_CAPABILITIES,
  CAPABILITIES,
  can,
  publicRoute,
  requires,
  ROLES,
  type Capability,
  type Role,
} from '../src/capabilities.js';

/**
 * The capability table (P0-49).
 *
 * The truth table in full, because that is the point of having a table at all:
 * scattered `if (role === 'OWNER')` checks cannot be enumerated, and anything
 * that cannot be enumerated cannot be shown to be complete.
 */

describe('the truth table, in full', () => {
  const expected: Record<Capability, readonly Role[]> = {
    'billing:manage': ['OWNER'],
    'members:manage': ['OWNER'],
    'domains:manage': ['OWNER'],
    'keys:manage': ['OWNER'],
    'widget:configure': ['OWNER'],
    'catalog:write': ['OWNER', 'EDITOR'],
    'catalog:read': ['OWNER', 'EDITOR'],
    'analytics:read': ['OWNER', 'EDITOR'],
  };

  const cases = ROLES.flatMap((role) =>
    ALL_CAPABILITIES.map(
      (capability) => [role, capability, expected[capability].includes(role)] as const,
    ),
  );

  it.each(cases)('%s %s the capability %s', (role, capability, allowed) => {
    expect(can(role, capability)).toBe(allowed);
  });

  it('covers every capability the table declares', () => {
    /*
     * The expectations above are hand-written, so they can fall behind the
     * table. `Record<Capability, …>` already makes a *missing* key a compile
     * error; this catches the other direction — a capability added to the table
     * and quietly given the same answer as its neighbour.
     */
    expect(Object.keys(expected).sort()).toEqual([...ALL_CAPABILITIES].sort());
  });

  it('runs the whole matrix, not a sample', () => {
    expect(cases).toHaveLength(ROLES.length * ALL_CAPABILITIES.length);
  });
});

describe('the shape of the table', () => {
  it('grants an EDITOR nothing that changes the account itself', () => {
    /*
     * The split is one question: does this change what the tenant *is*, or what
     * it *costs*? Billing, members, domains, keys and the widget's public
     * configuration all do — they alter the account or who can reach it — so an
     * EDITOR invited to maintain a catalogue must not touch any of them.
     */
    const editorHolds = ALL_CAPABILITIES.filter((capability) => can('EDITOR', capability));

    expect(editorHolds.sort()).toEqual(['analytics:read', 'catalog:read', 'catalog:write'].sort());
  });

  it('grants an OWNER everything, so no action is unreachable', () => {
    // A capability no role holds is a feature nobody can use — a silent dead
    // end rather than a deliberate restriction.
    for (const capability of ALL_CAPABILITIES) {
      expect(can('OWNER', capability), capability).toBe(true);
    }
  });

  it('names every capability as `subject:verb`', () => {
    // Not decoration: P0-50's matrix and P0-62's OpenAPI both group by subject,
    // and an off-pattern name silently forms its own group of one.
    for (const capability of ALL_CAPABILITIES) {
      expect(capability, capability).toMatch(/^[a-z]+:[a-z]+$/);
    }
  });

  it('lists no role that is not a role', () => {
    for (const [capability, roles] of Object.entries(CAPABILITIES)) {
      for (const role of roles) {
        expect(ROLES, `${capability} lists ${role}`).toContain(role);
      }
    }
  });
});

describe('route access declarations', () => {
  it('carries a written reason for a public route', () => {
    /*
     * Not a boolean, and not an absence. The only way to have a route with no
     * capability is to say out loud why — a sentence a reviewer can disagree
     * with, unlike a missing entry nobody noticed.
     */
    const access = publicRoute('Surface marker; returns no tenant data.');

    expect(access.kind).toBe('public');
    expect(access.reason.length).toBeGreaterThan(0);
  });

  it('carries the capability for a guarded route', () => {
    expect(requires('billing:manage')).toEqual({
      kind: 'capability',
      capability: 'billing:manage',
    });
  });
});
