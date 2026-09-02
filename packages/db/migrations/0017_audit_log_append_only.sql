-- The revoke is what makes this an audit log.
--
-- P0-21's ALTER DEFAULT PRIVILEGES grants app_rw SELECT, INSERT, UPDATE and
-- DELETE on every table app_migrate creates. A log the application can rewrite
-- records whatever the application last believed, not what happened — and the
-- case this exists for is the one where the application is misbehaving.
--
-- INSERT and SELECT stay: P0-53's writer appends, and the runbook that answers
-- "who removed that domain?" reads.
REVOKE UPDATE, DELETE ON audit_log FROM app_rw;
