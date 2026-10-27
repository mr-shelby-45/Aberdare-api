-- Hand-written (Phase T5 fix, approved by Ian on 2026-10-27): a settlement's
-- period_end is the server time taken after the close holds the location lock,
-- never before the previous settlement's period_end, and so no longer equals
-- received_at (the command's arrival, taken before the lock wait). The window
-- itself is the snapshot rule of T4; these times are what people see.
ALTER TABLE field_settlement DROP CONSTRAINT field_settlement_period;
ALTER TABLE field_settlement
  ADD CONSTRAINT field_settlement_period CHECK (period_end >= received_at AND period_start <= period_end);
ALTER TABLE field_settlement
  ADD CONSTRAINT field_settlement_sequence_positive CHECK (sequence >= 1);
