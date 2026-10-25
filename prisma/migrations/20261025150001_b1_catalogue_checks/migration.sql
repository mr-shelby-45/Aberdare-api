-- Hand-written (Phase B1): checks and the one-default-location index
-- (docs/phase-b-design.md sections 3 and 4). The service validates the same
-- rules first and gives a clear reason; these are the backstop.

-- Product names are stored trimmed, 1 to 120 characters. Not unique.
ALTER TABLE product
  ADD CONSTRAINT product_name_trimmed_length
  CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120);

-- Prices in KES are never negative. cost_price may be NULL (not set).
ALTER TABLE pack_type
  ADD CONSTRAINT pack_type_sell_price_not_negative CHECK (sell_price >= 0);
ALTER TABLE pack_type
  ADD CONSTRAINT pack_type_cost_price_not_negative CHECK (cost_price IS NULL OR cost_price >= 0);

-- units_per_pack > 0 exists since the spike (pack_type_units_per_pack_positive);
-- this adds the upper bound, so 1 to 10000 in all.
ALTER TABLE pack_type
  ADD CONSTRAINT pack_type_units_per_pack_max CHECK (units_per_pack <= 10000);

-- A barcode is text: letters, digits, dot, underscore, hyphen, 4 to 48
-- characters. No spaces (the service trims and normalises before storing).
ALTER TABLE product_barcode
  ADD CONSTRAINT product_barcode_format CHECK (barcode ~ '^[A-Za-z0-9._-]{4,48}$');

-- At most one default location per business. Archived rows still count, so
-- the default cannot be quietly replaced by archiving it (archiving the
-- default is refused by the service anyway).
CREATE UNIQUE INDEX location_one_default_per_business
  ON location (business_id)
  WHERE is_default;
