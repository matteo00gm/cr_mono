-- Reverses 0045_one_conversation_per_session.sql.
--
-- Dropping the index cannot fail on data: it removes a restriction rather than
-- imposing one. What it does remove is the guarantee that a session has one
-- conversation, so a rollback puts the duplicate-conversation failure back.
DROP INDEX IF EXISTS "conversations_tenant_session_key";
