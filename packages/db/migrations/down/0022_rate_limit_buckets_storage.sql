-- Reverses 0022_rate_limit_buckets_storage.sql.
--
-- RESET returns each parameter to its default rather than setting a number
-- here: writing the current defaults back would pin them, so a later Postgres
-- changing a default would silently not apply to this table.
--
-- Guarded, because 0021's down file drops the table and rolling both back in
-- order would otherwise fail here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'rate_limit_buckets') THEN
    ALTER TABLE rate_limit_buckets RESET (
      fillfactor,
      autovacuum_vacuum_threshold,
      autovacuum_vacuum_scale_factor,
      autovacuum_vacuum_cost_delay
    );
  END IF;
END
$$;
