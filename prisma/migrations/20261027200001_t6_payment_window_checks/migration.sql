-- Hand-written (Phase T6): the checks for payments in the settlement window.

-- reversed_txid is set exactly when the payment is REVERSED (the void sets both
-- in one UPDATE).
ALTER TABLE payment
  ADD CONSTRAINT payment_reversed_txid_with_status CHECK ((status = 'REVERSED') = (reversed_txid IS NOT NULL));

-- Expected cash and the M-Pesa totals may now be negative: a window can hold a
-- refund (a late void) and no new payments. Cash received and the unpaid total
-- stay never negative.
ALTER TABLE field_settlement
  DROP CONSTRAINT field_settlement_cash_not_negative,
  ADD CONSTRAINT field_settlement_cash_not_negative CHECK (cash_received >= 0 AND unpaid_total >= 0);
