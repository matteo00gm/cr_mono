-- Reverses 0061_billing_state.sql.
--
-- The constraint and both columns go. The two data repairs are not undone:
-- they made incoherent rows coherent, and putting them back would be
-- recreating the orphans the constraint was added to forbid.
ALTER TABLE "tenants" DROP CONSTRAINT "tenant_status_coherent";
ALTER TABLE "tenants" DROP COLUMN "billing_event_at";
ALTER TABLE "tenants" DROP COLUMN "trial_ends_at";
