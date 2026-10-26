-- Hand-written (Phase E1, docs/phase-e-design.md section 3): the sales rules
-- as database checks. The services check the same rules first and give clear
-- reasons; these are the backstop. Also widens the stock_movement and approval
-- checks of Phase C1 for SALE_VOID (a constraint cannot be altered in place,
-- so each is dropped and added again in this one migration; no policy,
-- trigger, function or index is touched).

-- ------------------------------------------------------------ sale
ALTER TABLE sale
  ADD CONSTRAINT sale_status_known CHECK (status IN ('COMPLETED', 'VOIDED'));
ALTER TABLE sale
  ADD CONSTRAINT sale_number_positive CHECK (sale_number >= 1);
ALTER TABLE sale
  ADD CONSTRAINT sale_local_ref_length CHECK (char_length(local_ref) BETWEEN 1 AND 30);
ALTER TABLE sale
  ADD CONSTRAINT sale_note_length CHECK (note IS NULL OR char_length(note) <= 200);
ALTER TABLE sale
  ADD CONSTRAINT sale_total_not_negative CHECK (total >= 0);
ALTER TABLE sale
  ADD CONSTRAINT sale_paid_total_not_negative CHECK (paid_total >= 0);
-- balance_due is never negative and always the greater of total - paid and 0.
ALTER TABLE sale
  ADD CONSTRAINT sale_balance_due CHECK (balance_due >= 0 AND balance_due = GREATEST(total - paid_total, 0));
-- Voided exactly when the four void fields are set; the note and the approval
-- may only be present on a voided sale.
ALTER TABLE sale
  ADD CONSTRAINT sale_void_fields_together
  CHECK (
    (status = 'VOIDED') = (voided_at IS NOT NULL)
    AND (voided_at IS NULL) = (voided_by_membership_id IS NULL)
    AND (voided_at IS NULL) = (void_reason IS NULL)
    AND (voided_at IS NULL) = (void_approved_by_membership_id IS NULL)
    AND (voided_at IS NOT NULL OR (void_note IS NULL AND void_approval_id IS NULL))
  );
ALTER TABLE sale
  ADD CONSTRAINT sale_void_reason_known
  CHECK (void_reason IS NULL OR void_reason IN ('MISTAKE', 'CUSTOMER_CANCELLED', 'WRONG_PRICE', 'OTHER'));
ALTER TABLE sale
  ADD CONSTRAINT sale_void_note_length CHECK (void_note IS NULL OR char_length(void_note) <= 200);

-- ------------------------------------------------------------ sale_item
ALTER TABLE sale_item
  ADD CONSTRAINT sale_item_line_no_positive CHECK (line_no >= 1);
ALTER TABLE sale_item
  ADD CONSTRAINT sale_item_quantity_range CHECK (quantity BETWEEN 1 AND 100000);
ALTER TABLE sale_item
  ADD CONSTRAINT sale_item_prices_not_negative
  CHECK (unit_price >= 0 AND list_price >= 0 AND (cost_price IS NULL OR cost_price >= 0));
-- Exact decimals: a NUMERIC(14,2) price times a whole quantity.
ALTER TABLE sale_item
  ADD CONSTRAINT sale_item_line_total CHECK (line_total = unit_price * quantity);

-- ------------------------------------------------------------ payment
ALTER TABLE payment
  ADD CONSTRAINT payment_method_known CHECK (method IN ('CASH', 'MPESA'));
ALTER TABLE payment
  ADD CONSTRAINT payment_amount_positive CHECK (amount > 0);
-- A code exactly on M-Pesa payments.
ALTER TABLE payment
  ADD CONSTRAINT payment_mpesa_code_on_mpesa CHECK ((method = 'MPESA') = (mpesa_code IS NOT NULL));
ALTER TABLE payment
  ADD CONSTRAINT payment_status_known CHECK (status IN ('RECORDED', 'REVERSED'));
ALTER TABLE payment
  ADD CONSTRAINT payment_not_duplicate_of_itself CHECK (duplicate_of_payment_id IS NULL OR duplicate_of_payment_id <> id);
-- Nothing verifies payments until Phase M.
ALTER TABLE payment
  ADD CONSTRAINT payment_unverified_until_phase_m CHECK (verified = false);

-- ------------------------------------------------------------ sale_counter
ALTER TABLE sale_counter
  ADD CONSTRAINT sale_counter_positive CHECK (last_number >= 1);

-- ------------------------------------------------------------ stock_movement
ALTER TABLE stock_movement DROP CONSTRAINT stock_movement_type_known;
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_type_known
  CHECK (movement_type IN ('RECEIVE', 'ADJUST', 'COUNT', 'CONVERT_OUT', 'CONVERT_IN', 'SALE', 'SALE_VOID'));

-- SALE is a decrease and SALE_VOID an increase (decided in E1). COUNT and
-- ADJUST stay sign-free here (ADJUST's sign is per reason, below in C1).
ALTER TABLE stock_movement DROP CONSTRAINT stock_movement_type_sign;
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_type_sign
  CHECK (CASE movement_type
           WHEN 'RECEIVE'     THEN quantity_change > 0
           WHEN 'CONVERT_IN'  THEN quantity_change > 0
           WHEN 'CONVERT_OUT' THEN quantity_change < 0
           WHEN 'SALE'        THEN quantity_change < 0
           WHEN 'SALE_VOID'   THEN quantity_change > 0
           ELSE true
         END);

-- sale_id only on SALE and SALE_VOID; required on SALE_VOID. Optional on SALE
-- while the spike's sale-mode code (no sale behind it) is still used by tests.
ALTER TABLE stock_movement
  ADD CONSTRAINT stock_movement_sale_id_on_sales
  CHECK (CASE movement_type
           WHEN 'SALE'      THEN true
           WHEN 'SALE_VOID' THEN sale_id IS NOT NULL
           ELSE sale_id IS NULL
         END);

-- ------------------------------------------------------------ approval
ALTER TABLE approval DROP CONSTRAINT approval_purpose_known;
ALTER TABLE approval
  ADD CONSTRAINT approval_purpose_known CHECK (purpose IN ('STOCK_CONVERT', 'SALE_VOID'));
