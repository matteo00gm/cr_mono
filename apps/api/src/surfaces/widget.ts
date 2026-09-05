import { Hono } from 'hono';

/**
 * The widget surface — `/v1/widget/*` (P0-54).
 *
 * Public, called from sellers' own sites, and authenticated by origin-bound
 * tokens rather than by session cookies (§3.4). It gets the permissive CORS
 * handler that the dashboard must never have (P2-08), and rate limiting keyed
 * on the visitor rather than on a user.
 *
 * A separate `Hono` instance for the same reason the dashboard is one, read in
 * the other direction: a public CORS middleware mounted on a shared root would
 * apply to the authenticated dashboard endpoints as well, which is how a
 * cross-origin page ends up able to read a seller's catalogue.
 */
export const createWidgetApp = (): Hono => {
  const app = new Hono();

  /** See the note on the dashboard surface marker. */
  app.get('/', (c) => c.json({ surface: 'widget' as const }));

  return app;
};
