-- MFA step-up and TOTP replay (P4-11).
--
-- `last_verified_at` is when a session last proved a second factor. The
-- step-up check reads it from this row rather than from the five-minute cookie
-- cache, so it is a column rather than something folded into the signed copy.
--
-- `auth_totp_claims` holds codes already spent. Better Auth accepts a TOTP code
-- as many times as it is sent within its window; a claim keyed on the user and
-- an HMAC of the code, refused a second time inside the window, is what makes a
-- code single-use. The primary key is the atomicity — two racing requests with
-- one code cannot both insert.
--
-- No tenant_id and no policy, like every `auth_*` table: authentication happens
-- before a tenant is known (P0-23a), and this table is reached only through the
-- auth adapter's connection.
ALTER TABLE "auth_sessions" ADD COLUMN "last_verified_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "auth_totp_claims" (
  "user_id" text NOT NULL,
  "code_hash" text NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "auth_totp_claims_pkey" PRIMARY KEY ("user_id", "code_hash")
);--> statement-breakpoint
ALTER TABLE "auth_totp_claims" ADD CONSTRAINT "auth_totp_claims_user_id_auth_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;
