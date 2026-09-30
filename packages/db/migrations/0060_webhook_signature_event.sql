-- A webhook that failed its signature check (P5-03).
--
-- Recorded as a security event because an unsigned or mis-signed POST to a
-- webhook endpoint is somebody trying to write billing state or suppress mail
-- without the provider's key: Stripe's endpoint in particular sets whether a
-- winery is served at all (§3.8). The provider and the reason go in
-- `metadata`; the type is what counting groups by. No tenant: a forged
-- delivery belongs to nobody, and its claims about a winery are not believed.
ALTER TYPE "public"."security_event_type" ADD VALUE IF NOT EXISTS 'INVALID_WEBHOOK_SIGNATURE';
