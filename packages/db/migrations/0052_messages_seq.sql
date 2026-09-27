-- The order messages were written in (review).
--
-- `created_at` is transaction time: two turns written in one transaction share
-- it exactly, and a clock step can reverse two that were not. Reading a
-- conversation by time then groups both questions before both answers. An
-- identity is assigned in insertion order, and a turn's question is inserted
-- before its answer in one statement, so it orders a conversation without
-- asking the clock.
--
-- Existing rows are numbered in the order the table stores them, which for a
-- conversation written turn by turn is the order they were written.
ALTER TABLE "messages" ADD COLUMN "seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_conversation_seq_idx" ON "messages" ("conversation_id", "seq");
