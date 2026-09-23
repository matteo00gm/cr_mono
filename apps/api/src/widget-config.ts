import type { WidgetConfigResponse } from '@catalogorosso/api-client';
import type { QuotaState } from '@catalogorosso/security';

import type { WidgetTenant } from './env.js';

/**
 * What `GET /v1/widget/config` answers (P2-10, §1.2).
 *
 * **Anything here is world-readable and edge-cached**, so the builder takes the
 * resolved tenant and returns a shape with no tenant id, no plan name and no
 * counts — nothing a competitor could read off a seller's own widget. The
 * schema in `@catalogorosso/api-client` is strict, so a field added here that
 * the contract does not name fails the route's own test.
 */

/**
 * The statuses a widget runs for (§1.3): paying, or trialling.
 *
 * Every other status — pending verification, past due, disabled, cancelled —
 * shows the visitor the same disabled state. The distinction between them is a
 * billing fact about the winery, and §1.3 says a visitor is never shown one.
 */
const SERVICEABLE: ReadonlySet<WidgetTenant['status']> = new Set(['ACTIVE', 'TRIALING']);

/** Whether a widget runs for this tenant at all — one answer for config (P2-10) and session mint (P2-12). */
export const isServiceable = (status: WidgetTenant['status']): boolean => SERVICEABLE.has(status);

/**
 * What a switched-off winery's widget is told, never naming why (§1.3) — by the
 * session mint (P2-12) and by every call that needs a session (P2-13).
 */
export const WIDGET_UNAVAILABLE = 'This widget is not available right now.';

/**
 * The appearance a widget has before a seller has chosen one.
 *
 * **Defaults, because nothing stores a seller's choice yet.** The widget
 * appearance screen (§2.3) is where colour, position, avatar and the welcome
 * message are set, and it is not built; until it is, every widget looks like
 * this. Recorded as open in the plan rather than invented as columns here.
 */
export const DEFAULT_THEME = {
  primaryColor: '#7b1e3a',
  position: 'bottom-right',
  avatarUrl: null,
} as const satisfies WidgetConfigResponse['theme'];

/** Where the cart icon sends a visitor by default (§1.6). */
export const DEFAULT_CART_URL = '/cart';

const WELCOME = {
  it: 'Ciao! Sono il sommelier di questa cantina. Che vino stai cercando?',
  en: "Hello! I'm this winery's sommelier. What kind of wine are you looking for?",
} as const;

export const widgetConfigFor = (
  tenant: WidgetTenant,
  quotaState: QuotaState,
): WidgetConfigResponse => ({
  status: isServiceable(tenant.status) ? 'ACTIVE' : 'DISABLED',
  locale: tenant.locale,
  theme: { ...DEFAULT_THEME },
  welcomeMessage: tenant.locale === 'en' ? WELCOME.en : WELCOME.it,
  cartUrl: DEFAULT_CART_URL,
  quotaState,
});
