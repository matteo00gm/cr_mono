-- Storage parameters, tuned for churn rather than for size.
--
-- This is the most update-heavy table in the schema: every widget request
-- increments several rows, and each UPDATE in Postgres writes a new tuple and
-- leaves a dead one behind. Left on the defaults, the table bloats between
-- vacuums and the limiter — a security control on the hot path — gets slower
-- exactly when traffic is highest.
--
-- fillfactor = 70 leaves room on each page for the new tuple to land beside the
-- old one, which keeps the update HOT: no index entry has to be rewritten.
--
-- scale_factor = 0.0 with an absolute threshold is the part worth explaining.
-- The default scale_factor is proportional to table size, and this table is
-- deliberately *small* — P2-14 sweeps closed windows away — while its churn is
-- high. A proportional trigger therefore waits for a percentage of a few
-- thousand rows while thousands of dead tuples accumulate. Making the trigger
-- absolute ties vacuuming to churn, which is the actual problem.
ALTER TABLE rate_limit_buckets SET (
  fillfactor = 70,
  autovacuum_vacuum_threshold = 200,
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_cost_delay = 0
);
