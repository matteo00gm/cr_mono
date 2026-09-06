import { can, type Capability, type Role } from '@catalogorosso/security';

/**
 * The navigation, and what each item requires (P0-57).
 *
 * ## The nav gate is UX, not security
 *
 * This is the single most important sentence in the dashboard, so it is at the
 * top of the module that would otherwise be mistaken for an authorization
 * layer. Hiding "Billing" from an `EDITOR` saves them from clicking something
 * that would refuse them; it does **not** stop them reaching it. A bundle
 * shipped to a browser is readable, editable and re-runnable by whoever
 * receives it, and the route is one typed URL away.
 *
 * What actually enforces the rule is the capability check on the server
 * (P0-49), which every dashboard route declares and P0-50's matrix asserts.
 * If the two ever disagree, the server is right and this file has a bug —
 * never the other way round.
 *
 * The consequence worth stating: **a change here is never a fix for an
 * authorization problem.** If an `EDITOR` can do something they should not,
 * the fix is in `DASHBOARD_ROUTES`, and adding a `can()` here as well would
 * only hide the symptom.
 *
 * Keeping the table here rather than inline in the layout is what makes the
 * gate reviewable in one place, and what lets a test enumerate it — the same
 * argument P0-49 makes for the route table it mirrors.
 */

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /**
   * The capability the *server* requires for this section.
   *
   * Undefined means every role may see it. Mirrored from the route table
   * rather than invented: a capability named here that no route requires would
   * hide a section for no reason, and the reverse would show one that always
   * refuses.
   */
  readonly capability?: Capability;
}

export const NAV: readonly NavItem[] = [
  { href: '/', label: 'Panoramica' },
  { href: '/catalogo', label: 'Catalogo', capability: 'catalog:write' },
  { href: '/conversazioni', label: 'Conversazioni', capability: 'analytics:read' },
  { href: '/membri', label: 'Membri', capability: 'members:manage' },
  { href: '/domini', label: 'Domini', capability: 'domains:manage' },
  { href: '/widget', label: 'Widget', capability: 'widget:configure' },
  { href: '/fatturazione', label: 'Fatturazione', capability: 'billing:manage' },
];

/**
 * The items this role should be shown.
 *
 * Pure, and exported separately from the component, so the rule can be tested
 * without rendering anything — and so the test reads as a statement about
 * roles rather than about markup.
 */
export const navFor = (role: Role): readonly NavItem[] =>
  NAV.filter((item) => item.capability === undefined || can(role, item.capability));
