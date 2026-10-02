-- Reverses 0070_message_recommendations.sql.
--
-- What was shown goes with the column; the candidates stay, so an answer is
-- still auditable for what the model was given.
ALTER TABLE "messages" DROP COLUMN IF EXISTS "recommended_product_ids";
