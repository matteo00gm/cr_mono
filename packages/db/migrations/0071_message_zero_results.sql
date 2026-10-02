-- Why an answer showed no wine (P6-04): the ZERO_RESULTS panel's own record.
--
-- Decided when the turn is written, from what reached the model, because
-- that is not kept: `no_match` when no candidate was found by the question's
-- words, `not_recommended` when some were and the model chose none. Null when
-- the answer showed a wine, and when it failed rather than answered. A CHECK
-- rather than a Postgres enum, so a third kind is one constraint swapped, and
-- one that also holds the kind to answers: a question has no result to lack.
ALTER TABLE "messages" ADD COLUMN "zero_result_kind" text;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_zero_result_kind_known"
  CHECK (zero_result_kind IS NULL OR (role = 'ASSISTANT' AND zero_result_kind IN ('no_match', 'not_recommended')));
