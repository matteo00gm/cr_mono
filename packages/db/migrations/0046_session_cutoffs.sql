-- Killing the sessions a removed domain left behind (P4-06, §3.3).
--
-- Removing a domain has to stop the widget working on it **now**, and today it
-- already does: CORS resolves `(pk_, Origin)` against verified domains on every
-- request, uncached, so a request from a removed origin is refused before a
-- token is ever read.
--
-- **That is a consequence of another row's design, not a guarantee of this
-- one.** §5.7 contemplates caching the allowlist, and the day that cache exists
-- the immediacy quietly becomes "within the TTL". This table is what still
-- works then. It also closes a gap CORS never covered: a seller who removes an
-- origin and later re-verifies it would otherwise resurrect every session that
-- was live when they removed it.
--
-- Its own table rather than a column on `tenant_domains`, because the domain row
-- is deleted — and a soft delete is not an option there: the unique index on
-- `origin` is the anti-sharing backbone (§3.2), and a tombstone would hold an
-- origin against every other winery for ever.
--
-- Per `(tenant, origin)` rather than per tenant. A cutoff for the whole winery
-- would kill live sessions on origins nobody removed, which is a visitor losing
-- their conversation on a storefront that is working perfectly.
CREATE TABLE "widget_session_cutoffs" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "origin" text NOT NULL,
  -- A session whose **first** token was minted before this is over. Compared
  -- against `iat_original`, never `iat`: comparing the current token's own
  -- issue time would let a session outlive its revocation by refreshing, which
  -- is exactly the thing being revoked.
  "valid_from" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "widget_session_cutoffs_pkey" PRIMARY KEY ("tenant_id", "origin")
);
--> statement-breakpoint
ALTER TABLE "widget_session_cutoffs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "widget_session_cutoffs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- The boilerplate tenant policy, and nothing more: no new RLS context, no
-- second GUC. By the time a cutoff is read, CORS has already resolved the
-- tenant from `(pk_, Origin)` — so this is read inside an ordinary
-- `withTenant`, exactly as `isTokenRevoked` reads `token_revocations` two
-- checks earlier on the same request.
CREATE POLICY "tenant_isolation" ON "widget_session_cutoffs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
