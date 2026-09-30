-- Staging origins (P4-19, §3.3).
--
-- Exact-origin matching means a seller who verified `winery.com` gets a
-- silently dead widget everywhere they would naturally test it first. A staging
-- origin is the supported answer, and two rules keep it from eating into what
-- production pays for: it does not count against the plan's domain cap (P4-07)
-- — it has its own cap of two — and it gets its own, lower rate limit while
-- sharing the winery's monthly quota. Both need to know which is which, so the
-- seller says so when adding the origin, and the row carries it.
CREATE TYPE "public"."domain_kind" AS ENUM('production', 'staging');
--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD COLUMN "kind" "domain_kind" DEFAULT 'production' NOT NULL;
