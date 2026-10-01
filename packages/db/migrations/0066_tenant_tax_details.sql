-- What an Italian business needs on its invoice (P5-02a).
--
-- From Checkout's optional custom fields, saved when a paid Checkout applies:
-- a Partita IVA (eleven digits) or a Codice Fiscale (sixteen characters), and
-- where SdI delivers the invoice — a seven-character Codice Destinatario, or a
-- PEC address. Null for a winery that gave none, which every winery outside
-- Italy is.
--
-- The shapes are CHECKs rather than trust in the one writer: the e-invoicing
-- bridge (P5-03a) sends these to SdI, and a malformed one is an invoice
-- rejected after the payment, where nobody is looking. The Partita IVA's check
-- digit is the application's (`normaliseVatId`); the database holds the shape.
ALTER TABLE "tenants" ADD COLUMN "vat_id" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "sdi_code" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "pec_address" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_vat_id_format"
  CHECK (vat_id IS NULL OR vat_id ~ '^([0-9]{11}|[A-Z0-9]{16})$');
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_sdi_code_format"
  CHECK (sdi_code IS NULL OR sdi_code ~ '^[A-Z0-9]{7}$');
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_pec_address_format"
  CHECK (pec_address IS NULL OR pec_address ~ '^[^@[:space:]]+@[^@[:space:]]+$');
