-- The token refusals P2-13 reports, and an address kept as a bucket (P2-16).
--
-- `INVALID_TOKEN` is the type for a token that did not verify, was revoked, or
-- carried no claims we mint: the six original types describe a key and an
-- origin, and none of them describes a token. Which of those it was goes in
-- `metadata`, because the enum drives counting rather than forensics.
--
-- `ip` becomes `ip_bucket`. P2-16 asks for the address hashed as P2-04 hashes
-- it, and an HMAC is not an `inet`. Nothing has ever written the column.
ALTER TYPE "public"."security_event_type" ADD VALUE IF NOT EXISTS 'INVALID_TOKEN';--> statement-breakpoint
ALTER TABLE "security_events" DROP COLUMN "ip";--> statement-breakpoint
ALTER TABLE "security_events" ADD COLUMN "ip_bucket" text;
