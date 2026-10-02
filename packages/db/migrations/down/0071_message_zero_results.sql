-- Reverses 0071_message_zero_results.sql.
--
-- The kinds go with the column; the cards (0070) stay, so an answer that
-- showed nothing is still one with an empty list.
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_zero_result_kind_known";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "zero_result_kind";
