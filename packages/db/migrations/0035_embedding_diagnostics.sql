-- Why a wine is not indexed, and how many times we have tried (P1-38).
--
-- `embedding_state` already says *what* a row is; neither column here changes
-- that, and both answer the question a seller actually asks when they see
-- FAILED: **why**. Without them the state is a colour on a grid with no way to
-- act on it, and the only recourse is reading worker logs — which a seller
-- cannot do and an operator can only do while the logs are still in retention.
--
-- `embedding_error` is free text rather than an enum, for the reason P0-31 gives
-- about `audit_log.action`: a provider that invents a new failure next month
-- must not need a migration before it can be recorded, because a schema change
-- on the write path is the friction that makes people record nothing.
ALTER TABLE products ADD COLUMN embedding_error text;

-- Separate from the outbox's own `attempts`, and the distinction matters.
-- `outbox.attempts` counts how many times the *poller* tried to publish a job;
-- this counts how many times the *provider* was asked and refused. A row that
-- has been published once and failed embedding four times is a very different
-- problem from one published four times and never embedded, and a single
-- counter cannot tell them apart — which is precisely the triage P1-50 has to
-- perform.
ALTER TABLE products ADD COLUMN embedding_attempts integer NOT NULL DEFAULT 0;

-- The question P1-50 asks, and the one a bounce-style alarm would ask: which
-- wines in this winery are stuck. Partial, because FAILED is a small and
-- shrinking set inside a table that only grows — the same reasoning as the
-- outbox's unprocessed index (P0-36).
CREATE INDEX products_tenant_failed_idx
  ON products (tenant_id, embedding_attempts)
  WHERE embedding_state = 'FAILED';
