/**
 * Where each surface is mounted (P0-45).
 *
 * One definition, because these strings are needed in three places that must
 * agree: the composition root mounts the sub-apps here, Better Auth is
 * configured with its own full public path, and the tests address the routes.
 *
 * The auth path is the one that actually bites. Better Auth is handed the raw
 * `Request`, whose URL carries the whole path — so its `basePath` has to be the
 * *mounted* path, not the sub-app-relative one, or every auth endpoint 404s.
 * It also builds password-reset and OAuth callback URLs from that value, so a
 * wrong one emails people links that go nowhere. Deriving it from the same
 * constants the mount uses is what stops the two drifting.
 */

export const DASHBOARD_PREFIX = '/v1/dashboard';
export const WIDGET_PREFIX = '/v1/widget';

/** Where the dashboard sub-app mounts Better Auth, relative to itself. */
export const AUTH_ROUTE_PREFIX = '/auth';

/** The full public path, which is what Better Auth must be configured with. */
export const AUTH_PUBLIC_PATH = `${DASHBOARD_PREFIX}${AUTH_ROUTE_PREFIX}`;
