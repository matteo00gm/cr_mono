-- Reverses 0074_attributions.sql.
--
-- The attributions go with their table: what the sommelier sold is not held
-- anywhere else, and the reverse schema has nowhere to keep it.
DROP TABLE IF EXISTS "attributions";
