-- Stock that Shopify reports, and when it said so (P6-11, §4.4).
--
-- `stock_source_at` is the moment the stock a wine now carries was true in
-- the shop: the `updated_at` of the product update it came from. Deliveries
-- are not ordered — a redelivery can arrive after the news that replaced it —
-- and this is what lets a late one be told from a new one. Null for a wine
-- whose stock a seller keeps by hand.
--
-- The trigger changes with it, for the reason 0038 gives. `updated_at` means
-- "when did the seller last change this wine", and sellers sort their
-- catalogue by it; a shop that sells a bottle should not move that wine to
-- the top of "recently edited". So a write that moves `stock_source_at` is a
-- report from the shop, not an edit, and the two stock columns are left out of
-- the comparison for that write alone. A seller changing stock by hand moves
-- no clock, and is still an edit.
ALTER TABLE "products" ADD COLUMN "stock_source_at" timestamp with time zone;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION products_set_updated_at() RETURNS trigger AS $$
DECLARE
  -- `updated_at` itself is excluded, or the comparison would never be equal:
  -- this is a BEFORE trigger, and NEW.updated_at still holds the old value
  -- only because nothing has assigned it yet.
  --
  -- `search_tsv` is excluded because it is GENERATED ALWAYS: Postgres computes
  -- a stored generated column *after* BEFORE triggers run, so inside here
  -- NEW.search_tsv is NULL and the two rows would always be distinct (0038).
  ignored text[] := ARRAY[
    'updated_at',
    'search_tsv',
    'embedding_state',
    'embedding_error',
    'embedding_attempts',
    'stock_source_at'
  ];
BEGIN
  -- A report from the shop, not an edit (P6-11): the clock moved, so whatever
  -- stock came with it is the shop's news rather than the seller's change.
  IF NEW.stock_source_at IS DISTINCT FROM OLD.stock_source_at THEN
    ignored := ignored || ARRAY['stock_status', 'stock_qty'];
  END IF;

  IF (to_jsonb(NEW) - ignored) IS DISTINCT FROM (to_jsonb(OLD) - ignored) THEN
    NEW.updated_at = now();
  ELSE
    NEW.updated_at = OLD.updated_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
