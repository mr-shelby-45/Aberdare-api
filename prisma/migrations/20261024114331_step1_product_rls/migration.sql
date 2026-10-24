-- Hand-written: row-level security and app_user privileges for step 1 tables.
-- Prisma does not generate or understand any of this. Review every later
-- generated migration to make sure it does not drop or alter these objects.

-- business: not tenant-owned in the spike, no RLS. The app only reads it.
-- (Creating businesses is a signup concern, not part of the spike.)
GRANT SELECT ON business TO app_user;

-- product: tenant table.
GRANT SELECT, INSERT, UPDATE, DELETE ON product TO app_user;

ALTER TABLE product ENABLE ROW LEVEL SECURITY;
-- FORCE makes the policy apply to the table owner (migrator) as well.
ALTER TABLE product FORCE ROW LEVEL SECURITY;

-- NULLIF turns an unset or emptied setting into NULL, which matches no rows,
-- instead of letting ''::uuid throw (docs/architecture.md section 3).
CREATE POLICY shop_only ON product
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
