-- Hand-written (Phase T1, docs/phase-t-design.md section 3): app_user's
-- privileges and row-level security for the field tables. All three are
-- append-only: no UPDATE, no DELETE. A settlement is final; a mistake is
-- corrected by the next settlement and a note.

-- ------------------------------------------------------------ grants
GRANT SELECT, INSERT ON stock_transfer TO app_user;
GRANT SELECT, INSERT ON field_settlement TO app_user;
GRANT SELECT, INSERT ON field_settlement_line TO app_user;

-- ------------------------------------------------------------ RLS
ALTER TABLE stock_transfer ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfer FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON stock_transfer
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE field_settlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_settlement FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON field_settlement
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE field_settlement_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_settlement_line FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON field_settlement_line
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
