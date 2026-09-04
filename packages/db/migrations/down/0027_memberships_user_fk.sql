-- Reverses 0027_memberships_user_fk.sql.
--
-- Drops only the constraint, leaving memberships.user_id in place as the plain
-- text column it was before P0-23a. Rolling this back must not lose the
-- membership rows themselves — the column predates the foreign key by four
-- migrations, and dropping it would take every tenant's roster with it.
ALTER TABLE "memberships" DROP CONSTRAINT IF EXISTS "memberships_user_id_auth_users_id_fk";
