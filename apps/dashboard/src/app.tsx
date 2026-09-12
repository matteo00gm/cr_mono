import type { JSX } from 'preact';
import { useMemo } from 'preact/hooks';
import { Link, Route, Switch, useLocation } from 'wouter-preact';

import { CatalogScreen } from './features/catalog/CatalogScreen.js';
import { navFor } from './nav.js';
import { apiFor, rememberTenant, useSession, type SessionState } from './session.js';
import type { ApiClient } from '@catalogorosso/api-client';
import type { Membership } from '@catalogorosso/api-client';

/**
 * The shell every dashboard screen mounts into (P0-57).
 *
 * `wouter-preact` rather than React Router: this is an authenticated console
 * with a handful of routes and no data loaders, nested layouts or transitions,
 * and the smaller library covers all of it. The size argument matters less here
 * than in the widget, but a router with features nobody uses is still a
 * dependency somebody has to keep current.
 */

/**
 * Everything below requires a session.
 *
 * A redirect and not a rendered sign-in form, because the form is Better Auth's
 * and lives at its own route — one place that talks to the auth endpoints,
 * rather than a second copy embedded in the shell.
 *
 * **This gate is not what protects anything.** It decides what to render;
 * `requireUser` on the server decides what may be read (P0-45), and every
 * request would be refused without a session whatever this component did.
 */
export const RequireAuth = ({
  session,
  children,
}: {
  readonly session: SessionState;
  readonly children: (signedIn: Extract<SessionState, { status: 'signed-in' }>) => JSX.Element;
}): JSX.Element => {
  const [, navigate] = useLocation();

  if (session.status === 'loading') {
    // Deliberately not a spinner. The session check is one same-origin request
    // and usually resolves before a spinner would finish fading in; showing one
    // makes a fast page feel slower than it is.
    return <div class="shell-loading" aria-busy="true" />;
  }

  if (session.status === 'signed-out') {
    /*
     * Rendered rather than thrown, and the link is real. A `navigate()` in
     * render is a side effect during a render pass, which Preact is entitled to
     * run twice — and a redirect that fires twice is a history entry the back
     * button cannot escape.
     */
    return (
      <div class="shell-signed-out">
        <p>La sessione è scaduta.</p>
        <a
          href="/accedi"
          onClick={(event: Event) => {
            event.preventDefault();
            navigate('/accedi');
          }}
        >
          Accedi
        </a>
      </div>
    );
  }

  return children(session);
};

/** The winery picker, shown only when the user belongs to more than one. */
const TenantPicker = ({
  memberships,
  active,
}: {
  readonly memberships: readonly Membership[];
  readonly active: Membership | undefined;
}): JSX.Element | null => {
  if (memberships.length <= 1) return null;

  return (
    <select
      class="shell-tenant"
      aria-label="Cantina attiva"
      value={active?.tenantId ?? ''}
      onChange={(event: Event) => {
        const tenantId = (event.currentTarget as HTMLSelectElement).value;
        rememberTenant(tenantId);
        /*
         * A reload rather than a state update. Every screen's data is scoped to
         * the active winery, so switching invalidates all of it at once —
         * and a reload cannot leave one component holding the previous
         * tenant's rows, which is the bug this avoids by construction.
         */
        globalThis.location.reload();
      }}
    >
      {memberships.map((membership) => (
        <option key={membership.tenantId} value={membership.tenantId}>
          {membership.tenantId}
        </option>
      ))}
    </select>
  );
};

const Placeholder = ({ title }: { readonly title: string }): JSX.Element => (
  <section>
    <h1>{title}</h1>
    <p>Questa schermata arriva con la sua attività.</p>
  </section>
);

/**
 * The catalogue, with a client built once per winery (P1-10b).
 *
 * Memoised because the screen's effects deliberately do not depend on the
 * client: `apiFor` returns a new object on every call, and a screen keyed on it
 * would refetch on every render of the shell.
 */
const CatalogRoute = ({
  tenantId,
  clientFor,
}: {
  readonly tenantId: string;
  readonly clientFor: (tenantId: string) => ApiClient;
}): JSX.Element => {
  const client = useMemo(() => clientFor(tenantId), [tenantId, clientFor]);
  return <CatalogScreen client={client} />;
};

/**
 * The signed-in layout.
 *
 * Split from `App` so a test can render it with a role directly, without
 * standing up a session or a fetch — which is what keeps the nav-gating test a
 * statement about roles rather than about mocking.
 */
export const Layout = ({
  session,
  clientFor = apiFor,
}: {
  readonly session: Extract<SessionState, { status: 'signed-in' }>;
  /**
   * How a screen gets a client for the active winery. Injected so a test can
   * mount a real screen without a network, the same seam `App` offers.
   */
  readonly clientFor?: ((tenantId: string) => ApiClient) | undefined;
}): JSX.Element => {
  const { active, memberships } = session;

  if (!active) {
    /*
     * Several memberships and no choice yet. Not defaulted to the first, for
     * the reason `chooseActive` gives: "first" is whatever order the server
     * returned, and writing to the wrong winery leaves no trace the seller
     * would recognise.
     */
    return (
      <main class="shell-choose">
        <h1>Scegli una cantina</h1>
        <TenantPicker memberships={memberships} active={undefined} />
      </main>
    );
  }

  return (
    <div class="shell">
      <header class="shell-header">
        <span class="shell-brand">AI Sommelier</span>
        <TenantPicker memberships={memberships} active={active} />
      </header>

      <nav class="shell-nav" aria-label="Sezioni">
        {navFor(active.role).map((item) => (
          <Link key={item.href} href={item.href}>
            {item.label}
          </Link>
        ))}
      </nav>

      <main class="shell-main">
        <Switch>
          <Route path="/">
            <Placeholder title="Panoramica" />
          </Route>
          <Route path="/catalogo">
            <CatalogRoute tenantId={active.tenantId} clientFor={clientFor} />
          </Route>
          <Route path="/membri">
            <Placeholder title="Membri" />
          </Route>
          <Route>
            {/* Unknown path. A 404 inside the shell rather than a blank page,
                so a stale bookmark is recognisable rather than alarming. */}
            <Placeholder title="Pagina non trovata" />
          </Route>
        </Switch>
      </main>
    </div>
  );
};

export const App = ({ client }: { readonly client?: ApiClient } = {}): JSX.Element => {
  const session = useSession(client);

  return <RequireAuth session={session}>{(signedIn) => <Layout session={signedIn} />}</RequireAuth>;
};
