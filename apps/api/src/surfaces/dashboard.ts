import { Hono } from 'hono';

/**
 * The dashboard surface — `/v1/dashboard/*` (P0-54).
 *
 * Everything a signed-in seller does. It is cookie-authenticated (P0-45),
 * tenant-scoped from `memberships` (P0-47), and capability-checked (P0-49).
 *
 * **Its middleware stack must never reach the widget surface**, which is why
 * this is a separate `Hono` instance rather than a route group on a shared one.
 * Middleware registered on a parent app runs for every child, so a Better Auth
 * handler mounted on a common root would sit in front of the public widget
 * endpoints too — and the widget deliberately accepts no cookies at all (§3.4,
 * P2-08 sets `Access-Control-Allow-Credentials: false`). Two instances make
 * that structural instead of a thing reviewers have to notice.
 */
export const createDashboardApp = (): Hono => {
  const app = new Hono();

  /*
   * A surface marker, and the assertion P0-46's surface-isolation tests hang
   * off until real routes exist. It returns the name of the stack that served
   * the request, so a test can prove *which* app handled a path rather than
   * only that something did — the distinction that matters when the bug being
   * hunted is one surface answering for the other.
   */
  app.get('/', (c) => c.json({ surface: 'dashboard' as const }));

  return app;
};
