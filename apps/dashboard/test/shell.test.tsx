import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Layout, RequireAuth } from '../src/app.js';
import { NAV, navFor } from '../src/nav.js';
import { chooseActive } from '../src/session.js';
import type { SessionState } from '../src/session.js';

/**
 * The dashboard shell (P0-57).
 *
 * Two things are asserted, and the second carries a warning worth repeating
 * everywhere it appears: **the nav gate is UX, not security.** These tests say
 * an `EDITOR` is not *shown* Billing. They say nothing about whether an
 * `EDITOR` can *reach* it, because that is the server's answer (P0-49) and
 * P0-50's matrix is where it is asserted. A green run here is not evidence that
 * anything is protected.
 */

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

const signedIn = (
  role: 'OWNER' | 'EDITOR',
  memberships = [{ tenantId: TENANT_A, role }],
): Extract<SessionState, { status: 'signed-in' }> => ({
  status: 'signed-in',
  userId: 'user_matteo',
  memberships,
  active: { tenantId: TENANT_A, role },
});

afterEach(cleanup);

describe('RequireAuth', () => {
  it('renders the sign-in route for a signed-out caller', () => {
    render(<RequireAuth session={{ status: 'signed-out' }}>{() => <p>catalogo</p>}</RequireAuth>);

    expect(screen.getByRole('link', { name: 'Accedi' })).toHaveProperty(
      'href',
      expect.stringContaining('/accedi'),
    );
    // And nothing behind the gate rendered. The children are a function rather
    // than an element precisely so they cannot be evaluated before the check.
    expect(screen.queryByText('catalogo')).toBeNull();
  });

  it('navigates rather than following the href on click', () => {
    /*
     * The link is real so it works with middle-click, copy-link and a keyboard,
     * and the handler is what keeps a normal click inside the SPA. A
     * `navigate()` called during *render* instead would be a side effect in a
     * pass Preact is entitled to run twice — and a redirect that fires twice is
     * a history entry the back button cannot escape.
     */
    render(<RequireAuth session={{ status: 'signed-out' }}>{() => <p>catalogo</p>}</RequireAuth>);

    const link = screen.getByRole('link', { name: 'Accedi' });
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('renders nothing decisive while the session is still loading', () => {
    const { container } = render(
      <RequireAuth session={{ status: 'loading' }}>{() => <p>catalogo</p>}</RequireAuth>,
    );

    /*
     * Neither the console nor the sign-in prompt. Showing "session expired"
     * during the first request is the flash every SPA does once and every user
     * reads as being logged out.
     */
    expect(screen.queryByText('catalogo')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Accedi' })).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('renders the console for a signed-in caller', () => {
    render(<RequireAuth session={signedIn('OWNER')}>{() => <p>catalogo</p>}</RequireAuth>);

    expect(screen.getByText('catalogo')).not.toBeNull();
  });
});

describe('the navigation gate', () => {
  /*
   * Scoped to the nav landmark rather than the whole document. "Panoramica" is
   * both a nav item and the heading of the page it points at, so a document-wide
   * query matches twice — and a test that fails on a *second* match would also
   * pass if the heading were the only one left.
   */
  const navLinks = () => within(screen.getByRole('navigation', { name: 'Sezioni' }));

  it('shows an OWNER every section', () => {
    // Guards the guard: if `navFor` returned nothing, the EDITOR assertion
    // below would pass while the nav was simply broken.
    render(<Layout session={signedIn('OWNER')} />);

    for (const item of NAV) {
      expect(navLinks().getByText(item.label), item.label).not.toBeNull();
    }
  });

  it('hides the OWNER-only sections from an EDITOR', () => {
    render(<Layout session={signedIn('EDITOR')} />);

    // OWNER-only, per the capability table in packages/security.
    for (const label of ['Membri', 'Fatturazione', 'Domini', 'Widget']) {
      expect(navLinks().queryByText(label), label).toBeNull();
    }

    // And the sections an EDITOR does hold are still there, so this is a gate
    // rather than an empty nav.
    expect(navLinks().getByText('Catalogo')).not.toBeNull();
    expect(navLinks().getByText('Conversazioni')).not.toBeNull();
  });

  it('is derived from the capability table, not from a second list', () => {
    /*
     * The failure this catches: somebody adds a capability to
     * `packages/security` and grants it to EDITOR, and the nav keeps hiding the
     * section because a hard-coded role check here was never updated. Asserting
     * against `can()` rather than against a literal list is what keeps the two
     * from drifting.
     */
    const owner = navFor('OWNER').map((item) => item.href);
    const editor = navFor('EDITOR').map((item) => item.href);

    expect(owner).toEqual(NAV.map((item) => item.href));
    expect(editor.length).toBeLessThan(owner.length);
    expect(editor.every((href) => owner.includes(href))).toBe(true);
  });
});

describe('choosing a winery', () => {
  it('needs no choice when there is one membership', () => {
    expect(chooseActive([{ tenantId: TENANT_A, role: 'OWNER' }], undefined)).toEqual({
      tenantId: TENANT_A,
      role: 'OWNER',
    });
  });

  it('honours a remembered choice', () => {
    const memberships = [
      { tenantId: TENANT_A, role: 'OWNER' as const },
      { tenantId: TENANT_B, role: 'EDITOR' as const },
    ];

    expect(chooseActive(memberships, TENANT_B)?.tenantId).toBe(TENANT_B);
  });

  it('ignores a remembered choice that is no longer a membership', () => {
    /*
     * The case that matters: somebody's access to a winery is revoked, and
     * their browser still holds the id. Falling back to "no choice" shows the
     * picker; falling back to *the first membership* would silently move them
     * into a different winery, and the next thing they edit would land there.
     */
    const memberships = [
      { tenantId: TENANT_A, role: 'OWNER' as const },
      { tenantId: TENANT_B, role: 'EDITOR' as const },
    ];

    expect(chooseActive(memberships, '33333333-3333-3333-3333-333333333333')).toBeUndefined();
  });

  it('asks rather than guessing when there are several and no memory', () => {
    const memberships = [
      { tenantId: TENANT_A, role: 'OWNER' as const },
      { tenantId: TENANT_B, role: 'EDITOR' as const },
    ];

    expect(chooseActive(memberships, undefined)).toBeUndefined();
  });

  it('shows the picker instead of the console when no winery is chosen', () => {
    render(
      <Layout
        session={{
          status: 'signed-in',
          userId: 'user_matteo',
          memberships: [
            { tenantId: TENANT_A, role: 'OWNER' },
            { tenantId: TENANT_B, role: 'EDITOR' },
          ],
          active: undefined,
        }}
      />,
    );

    expect(screen.getByRole('combobox', { name: 'Cantina attiva' })).not.toBeNull();
    // No nav, because there is no winery for it to be scoped to yet.
    expect(screen.queryByRole('navigation', { name: 'Sezioni' })).toBeNull();
  });

  it('reloads on switching, rather than re-rendering in place', () => {
    /*
     * The decision worth pinning. Every screen's data is scoped to the active
     * winery, so switching invalidates all of it at once — and a reload cannot
     * leave one component still holding the previous tenant's rows, which is a
     * bug that would show a seller another winery's catalogue and look like
     * theirs.
     */
    const reload = vi.fn();
    // A plain object rather than a spread of the real `Location`: spreading a
    // class instance drops its prototype, and the component only reaches for
    // `reload`.
    vi.stubGlobal('location', { href: globalThis.location.href, reload });

    render(
      <Layout
        session={{
          status: 'signed-in',
          userId: 'user_matteo',
          memberships: [
            { tenantId: TENANT_A, role: 'OWNER' },
            { tenantId: TENANT_B, role: 'EDITOR' },
          ],
          active: { tenantId: TENANT_A, role: 'OWNER' },
        }}
      />,
    );

    const picker = screen.getByRole('combobox', { name: 'Cantina attiva' });
    fireEvent.change(picker, { target: { value: TENANT_B } });

    expect(reload).toHaveBeenCalledTimes(1);
    // And the choice is remembered before the reload, or the page comes back
    // in the winery the user just left.
    expect(globalThis.localStorage.getItem('sommelier.activeTenant')).toBe(TENANT_B);

    vi.unstubAllGlobals();
  });

  it('does not show a picker to somebody with one winery', () => {
    render(<Layout session={signedIn('OWNER')} />);

    // A select with one option is a control that cannot do anything, and it
    // invites the question "what else is in there?".
    expect(screen.queryByRole('combobox', { name: 'Cantina attiva' })).toBeNull();
  });
});
