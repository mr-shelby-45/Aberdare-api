-- Hand-written (Phase B1): privileges and row-level security for
-- product_barcode. Same pattern as every tenant table.

-- The only catalogue table where app_user may DELETE (barcode.remove). No
-- UPDATE: a barcode is moved by removing it and adding it again.
GRANT SELECT, INSERT, DELETE ON product_barcode TO app_user;

ALTER TABLE product_barcode ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_barcode FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON product_barcode
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
