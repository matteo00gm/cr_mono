-- Reverses 0012_conversations_messages.sql.
--
-- messages first: it references conversations.
DROP TABLE IF EXISTS "messages";

DROP TABLE IF EXISTS "conversations";

DROP TYPE IF EXISTS "message_role";
