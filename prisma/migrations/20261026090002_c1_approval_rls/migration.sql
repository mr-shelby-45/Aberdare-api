-- Hand-written (Phase C1): privileges and row-level security for approval
-- (docs/phase-c-design.md section 3).

-- Minting inserts; using it updates only the two consumption columns (one
-- atomic UPDATE ... WHERE consumed_at IS NULL ...). Nothing else about an
-- approval can change after it is minted, and app_user can never delete one.
GRANT SELECT, INSERT ON approval TO app_user;
GRANT UPDATE (consumed_at, consumed_by_sync_command_id) ON approval TO app_user;

ALTER TABLE approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON approval
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
