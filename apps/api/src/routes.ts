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

/**
 * Where provider webhooks arrive (P0-64b).
 *
 * A third prefix rather than a route on the dashboard, because what
 * authenticates a request here is neither a session nor an origin token but the
 * provider's own signature — and P0-33's Stripe handler needs the same rules.
 * Under `/v1/` so it reaches the Lambda through the CloudFront behaviour that
 * already exists, and so it carries the A2 origin secret like every other
 * request rather than needing a hole cut for it.
 */
export const WEBHOOK_PREFIX = '/v1/webhooks';
