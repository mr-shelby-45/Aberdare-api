-- Hand-written (Phase C1): the ledger rules of docs/phase-c-design.md
-- section 3, as database checks. The services check the same rules first and
-- give clear reasons; these are the backstop. The existing
-- stock_movement_quantity_change_nonzero (quantity_change <> 0) stays.

-- ------------------------------------------------------------ stock_movement
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_type_known
  CHECK (movement_type IN ('RECEIVE', 'ADJUST', 'COUNT', 'CONVERT_OUT', 'CONVERT_IN', 'SALE'));

-- Signs per type. COUNT, ADJUST (below) and SALE are not fixed here; SALE is
-- the spike's sale-mode decrease, and Phase E decides its rules.
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_type_sign
  CHECK (CASE movement_type
           WHEN 'RECEIVE'     THEN quantity_change > 0
           WHEN 'CONVERT_IN'  THEN quantity_change > 0
           WHEN 'CONVERT_OUT' THEN quantity_change < 0
           ELSE true
         END);

-- A reason exactly on ADJUST, from the known list, with a sign that fits it
-- (CORRECTION and OTHER may go either way).
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_reason_on_adjust
  CHECK ((movement_type = 'ADJUST') = (reason IS NOT NULL));
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_reason_known
  CHECK (reason IS NULL
         OR reason IN ('DAMAGED', 'EXPIRED', 'LOST', 'FOUND', 'SUPPLIER_RETURN', 'CORRECTION', 'OTHER'));
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_reason_sign
  CHECK (CASE
           WHEN reason = 'FOUND' THEN quantity_change > 0
           WHEN reason IN ('DAMAGED', 'EXPIRED', 'LOST', 'SUPPLIER_RETURN') THEN quantity_change < 0
           ELSE true
         END);

-- A unit cost only on RECEIVE, never negative.
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_unit_cost_on_receive
  CHECK (unit_cost IS NULL OR (movement_type = 'RECEIVE' AND unit_cost >= 0));

-- Expected and counted exactly on COUNT, and the change is their difference.
-- counted_quantity is never negative; expected may be (a phone's balance can be).
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_count_quantities
  CHECK (CASE WHEN movement_type = 'COUNT'
              THEN expected_quantity IS NOT NULL
                   AND counted_quantity IS NOT NULL
                   AND counted_quantity >= 0
                   AND quantity_change = counted_quantity - expected_quantity
              ELSE expected_quantity IS NULL AND counted_quantity IS NULL
         END);

ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_note_length CHECK (note IS NULL OR char_length(note) <= 200);
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_reference_length CHECK (reference IS NULL OR char_length(reference) <= 60);

-- ------------------------------------------------------------ approval
ALTER TABLE approval
  ADD CONSTRAINT approval_purpose_known CHECK (purpose IN ('STOCK_CONVERT'));
ALTER TABLE approval
  ADD CONSTRAINT approval_valid_after_created CHECK (valid_until > created_at);
-- Consumed means both: when, and by which command.
ALTER TABLE approval
  ADD CONSTRAINT approval_consumed_together
  CHECK ((consumed_at IS NULL) = (consumed_by_sync_command_id IS NULL));

-- ------------------------------------------------------------ membership
ALTER TABLE membership
  ADD CONSTRAINT membership_approval_failed_count_not_negative CHECK (approval_failed_count >= 0);
