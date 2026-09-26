-- Reverse of 0046 (P0-40).
--
-- Runs after 0047's reverse has removed the policy, so this drops the table
-- alone. Every cutoff is lost, which
-- means sessions revoked by a domain removal become valid again on any origin
-- that is still verified — so this is a reversal to run before the removals it
-- protects, not after.
DROP TABLE IF EXISTS "widget_session_cutoffs";
