-- The cards a visitor was shown, on the answer that showed them (P6-03).
--
-- `retrieved_product_ids` holds the candidates the model was given, up to
-- eight; the cards are the model's choice among them, after the allowlist.
-- "Top recommended wines" asks for the second, and counting the first would
-- credit a wine with every answer it was passed over in. Not a foreign key
-- array, as the candidates are not: a wine archived or deleted since was
-- still recommended. Null for answers written before this column existed,
-- which the panel reads as "no cards recorded" rather than "no cards".
ALTER TABLE "messages" ADD COLUMN "recommended_product_ids" uuid[];
