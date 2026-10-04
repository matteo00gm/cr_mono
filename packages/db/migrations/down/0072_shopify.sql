-- Reverses 0072_shopify.sql.
--
-- The installations and any unfinished installs go with their tables. A
-- domain proved by the install has no proof left that the reverse schema can
-- name, so it goes back to PENDING — honest, and the seller can prove it
-- again — before the enum is rebuilt without the value. Postgres cannot drop
-- an enum value, so the type is replaced.
DROP TABLE IF EXISTS "shopify_oauth_states";
DROP TABLE IF EXISTS "shopify_installations";
UPDATE tenant_domains
   SET status = 'PENDING', verification_method = NULL, verified_at = NULL
 WHERE verification_method = 'SHOPIFY';
ALTER TYPE "domain_verification_method" RENAME TO "domain_verification_method_0072";
CREATE TYPE "domain_verification_method" AS ENUM ('DNS_TXT', 'WELL_KNOWN');
ALTER TABLE tenant_domains
  ALTER COLUMN verification_method TYPE "domain_verification_method"
  USING verification_method::text::"domain_verification_method";
DROP TYPE "domain_verification_method_0072";
