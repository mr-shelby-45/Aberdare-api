-- Hand-written: checks, app_user privileges and row-level security for the
-- step 2 stock tables. Prisma does not generate or understand any of this.

-- Checks Prisma cannot express. Deliberately NO check on stock_balance.quantity:
-- sale mode must be able to take it below zero (docs/architecture.md section 6).
ALTER TABLE pack_type
  ADD CONSTRAINT pack_type_units_per_pack_positive CHECK (units_per_pack > 0);
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_quantity_change_nonzero CHECK (quantity_change <> 0);
-- A conversion links two different ledger rows, never one row to itself.
ALTER TABLE stock_conversion
  ADD CONSTRAINT stock_conversion_movements_differ CHECK (out_movement_id <> in_movement_id);

-- Privileges. No DELETE on any stock table.
GRANT SELECT, INSERT, UPDATE ON location         TO app_user;
GRANT SELECT, INSERT, UPDATE ON pack_type        TO app_user;
GRANT SELECT, INSERT, UPDATE ON stock_balance    TO app_user;
-- Append-only: app_user can never edit or delete a ledger row.
GRANT SELECT, INSERT         ON stock_movement   TO app_user;
GRANT SELECT, INSERT         ON stock_conversion TO app_user;

-- Row-level security: enabled and forced, same NULLIF policy as product.
ALTER TABLE location ENABLE ROW LEVEL SECURITY;
ALTER TABLE location FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON location
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE pack_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE pack_type FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON pack_type
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE stock_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_balance FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON stock_balance
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE stock_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movement FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON stock_movement
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE stock_conversion ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_conversion FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON stock_conversion
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
