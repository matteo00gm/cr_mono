-- The per-winery Turnstile flag (P4-14).
--
-- Off for every winery, existing and new: §3.6 makes the challenge a response
-- to abuse, not a default, and the default widget loads nothing from a third
-- party. An owner turns it on from the dashboard.
ALTER TABLE "tenants" ADD COLUMN "turnstile_enabled" boolean DEFAULT false NOT NULL;
