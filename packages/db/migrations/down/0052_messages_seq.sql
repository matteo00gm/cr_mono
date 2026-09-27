-- Reverses 0052_messages_seq.sql. The column is derived — an order the rows
-- already have — so dropping it loses nothing but the ordering it gave.
DROP INDEX IF EXISTS "messages_conversation_seq_idx";

ALTER TABLE "messages" DROP COLUMN IF EXISTS "seq";
