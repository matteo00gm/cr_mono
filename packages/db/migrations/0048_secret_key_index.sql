-- One active row per secret key (P4-10, ADR 0026).
--
-- A server finds its tenant by looking a presented key's SHA-256 up by value
-- (ADR 0025), so the lookup needs an index — and it needs a unique one. With
-- 256-bit keys two tenants never share a hash by chance; what the constraint
-- catches is the bug that would make them, which without it would authenticate
-- a key as whichever tenant `LIMIT 1` happened to return.
--
-- Partial, on `revoked_at IS NULL`, because a public-key rotation (P4-08)
-- carries the secret hash onto the new row and the revoked row keeps its copy
-- through the grace window. Two rows share a hash for a day by design; only one
-- of them is ever the key.
CREATE UNIQUE INDEX "widget_keys_active_secret_key_hash_key"
  ON "widget_keys" ("secret_key_hash")
  WHERE "revoked_at" IS NULL;
