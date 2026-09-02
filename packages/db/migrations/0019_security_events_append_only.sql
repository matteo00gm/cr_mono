-- Append-only, as P0-31.
--
-- The reasoning is sharper here than for audit_log: this table records attacks.
-- The credential most likely to be in an attacker's hands is the application's
-- own, and UPDATE or DELETE on this table would let whoever holds it erase the
-- evidence of what they did. Enforced by the grant, so a bug in the writer
-- cannot do it either.
REVOKE UPDATE, DELETE ON security_events FROM app_rw;
