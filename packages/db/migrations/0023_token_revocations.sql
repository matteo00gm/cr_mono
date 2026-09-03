CREATE TABLE "token_revocations" (
	"jti" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "token_revocations" ADD CONSTRAINT "token_revocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "token_revocations_expires_at_idx" ON "token_revocations" USING btree ("expires_at");