-- Hand-written (Phase E1, docs/phase-e-design.md section 3): app_user's
-- privileges and row-level security for the sales tables. No DELETE anywhere:
-- a wrong sale is voided (a status change and new rows), never removed.

-- ------------------------------------------------------------ grants
-- sale: inserted once; later only payments (paid_total, balance_due) and the
-- void (status and the void columns) change it.
GRANT SELECT, INSERT ON sale TO app_user;
GRANT UPDATE (status, paid_total, balance_due, voided_at, voided_by_membership_id, void_reason,
              void_note, void_approval_id, void_approved_by_membership_id)
  ON sale TO app_user;
-- sale_item: append-only.
GRANT SELECT, INSERT ON sale_item TO app_user;
-- payment: never edited; only reversed (status) by a void.
GRANT SELECT, INSERT ON payment TO app_user;
GRANT UPDATE (status) ON payment TO app_user;
-- sale_counter: the first sale inserts the row; later sales increment it.
GRANT SELECT, INSERT ON sale_counter TO app_user;
GRANT UPDATE (last_number) ON sale_counter TO app_user;

-- ------------------------------------------------------------ RLS
ALTER TABLE sale ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON sale
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE sale_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_item FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON sale_item
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON payment
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE sale_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_counter FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_only ON sale_counter
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

-- ------------------------------------------------------------ a voided sale is final
-- Restrictive: applies on top of shop_only (the pattern of sync_command's
-- outcome_is_final, spike step 3). Only a COMPLETED sale can be updated, so
-- once VOIDED no UPDATE matches it (zero rows, no error). WITH CHECK (true) is
-- required: without it Postgres reuses USING for the new row, which would
-- block the COMPLETED -> VOIDED update itself. Chosen over a trigger (E1).
CREATE POLICY voided_is_final ON sale
  AS RESTRICTIVE
  FOR UPDATE
  USING (status = 'COMPLETED')
  WITH CHECK (true);
