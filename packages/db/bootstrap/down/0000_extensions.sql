-- Reverses 0000_extensions.sql.
--
-- Exists so the up/down/up drill in P0-40 covers bootstrap as well as the
-- migration chain. Not something to run against a stage that holds data: every
-- column typed vector, halfvec or citext goes with it, which is the point of
-- RESTRICT being the default. Any table still using them makes this fail rather
-- than cascade.
DROP EXTENSION IF EXISTS citext;
DROP EXTENSION IF EXISTS unaccent;
DROP EXTENSION IF EXISTS pg_trgm;
DROP EXTENSION IF EXISTS vector;
