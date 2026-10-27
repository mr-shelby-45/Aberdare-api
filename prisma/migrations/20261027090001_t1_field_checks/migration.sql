-- Hand-written (Phase T1, docs/phase-t-design.md section 3): checks for field
-- locations, transfers, the two new movement columns and settlements.

-- ------------------------------------------------------------ location
ALTER TABLE location
  ADD CONSTRAINT location_kind_known CHECK (kind IN ('SHOP', 'WAREHOUSE', 'FIELD'));
-- Assigned exactly when FIELD. The assignee's preset is checked by the service
-- at assignment; a later preset change does not remove the assignment.
ALTER TABLE location
  ADD CONSTRAINT location_assignee_on_field CHECK ((kind = 'FIELD') = (assigned_membership_id IS NOT NULL));
ALTER TABLE location
  ADD CONSTRAINT location_field_not_default CHECK (NOT (kind = 'FIELD' AND is_default));

-- ------------------------------------------------------------ stock_transfer
ALTER TABLE stock_transfer
  ADD CONSTRAINT stock_transfer_kind_known CHECK (kind IN ('ISSUE', 'RETURN'));
ALTER TABLE stock_transfer
  ADD CONSTRAINT stock_transfer_locations_differ CHECK (from_location_id <> to_location_id);
ALTER TABLE stock_transfer
  ADD CONSTRAINT stock_transfer_reference_length CHECK (reference IS NULL OR char_length(reference) <= 60);
ALTER TABLE stock_transfer
  ADD CONSTRAINT stock_transfer_note_length CHECK (note IS NULL OR char_length(note) <= 200);

-- ------------------------------------------------------------ stock_movement
ALTER TABLE stock_movement DROP CONSTRAINT stock_movement_type_known;
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_type_known
  CHECK (movement_type IN ('RECEIVE', 'ADJUST', 'COUNT', 'CONVERT_OUT', 'CONVERT_IN', 'SALE', 'SALE_VOID',
                           'TRANSFER_OUT', 'TRANSFER_IN'));

ALTER TABLE stock_movement DROP CONSTRAINT stock_movement_type_sign;
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_type_sign
  CHECK (CASE movement_type
           WHEN 'RECEIVE'      THEN quantity_change > 0
           WHEN 'CONVERT_IN'   THEN quantity_change > 0
           WHEN 'CONVERT_OUT'  THEN quantity_change < 0
           WHEN 'SALE'         THEN quantity_change < 0
           WHEN 'SALE_VOID'    THEN quantity_change > 0
           WHEN 'TRANSFER_OUT' THEN quantity_change < 0
           WHEN 'TRANSFER_IN'  THEN quantity_change > 0
           ELSE true
         END);

-- transfer_id exactly on the two transfer types.
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_transfer_id_on_transfers
  CHECK ((movement_type IN ('TRANSFER_OUT', 'TRANSFER_IN')) = (transfer_id IS NOT NULL));
-- settlement_id only on ADJUST (a settlement's LOST and FOUND adjustments).
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_settlement_id_on_adjust
  CHECK (settlement_id IS NULL OR movement_type = 'ADJUST');

-- ------------------------------------------------------------ field_settlement
ALTER TABLE field_settlement
  ADD CONSTRAINT field_settlement_cash_not_negative
  CHECK (expected_cash >= 0 AND cash_received >= 0 AND mpesa_verified_total >= 0
         AND mpesa_unverified_total >= 0 AND unpaid_total >= 0);
ALTER TABLE field_settlement
  ADD CONSTRAINT field_settlement_cash_variance CHECK (cash_variance = cash_received - expected_cash);
ALTER TABLE field_settlement
  ADD CONSTRAINT field_settlement_counts_not_negative CHECK (sale_count >= 0 AND voided_count >= 0);
-- The window ends at the close's server time and never runs backwards.
ALTER TABLE field_settlement
  ADD CONSTRAINT field_settlement_period CHECK (period_end = received_at AND period_start <= period_end);
ALTER TABLE field_settlement
  ADD CONSTRAINT field_settlement_note_length CHECK (note IS NULL OR char_length(note) <= 200);

-- ------------------------------------------------------------ field_settlement_line
ALTER TABLE field_settlement_line
  ADD CONSTRAINT field_settlement_line_flows_not_negative
  CHECK (issued >= 0 AND returned >= 0 AND sold >= 0 AND voided_back >= 0);
ALTER TABLE field_settlement_line
  ADD CONSTRAINT field_settlement_line_counted_range CHECK (counted_quantity BETWEEN 0 AND 2000000000);
ALTER TABLE field_settlement_line
  ADD CONSTRAINT field_settlement_line_variance CHECK (variance = counted_quantity::bigint - expected_quantity);
