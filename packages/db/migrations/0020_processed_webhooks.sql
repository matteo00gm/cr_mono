CREATE TABLE "processed_webhooks" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_webhooks_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
