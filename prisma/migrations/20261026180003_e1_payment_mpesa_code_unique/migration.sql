-- Hand-written (Phase E1, docs/phase-e-design.md section 3): one original
-- payment per M-Pesa code per business. A reused code is still saved, as a
-- payment marked duplicate_of_payment_id (the sale is never refused), and
-- duplicates are outside this index. Reversed payments keep their code, so a
-- voided sale does not free it. A partial index: Prisma cannot declare it and
-- does not try to drop it (listed in HAND_WRITTEN_INDEXES).
CREATE UNIQUE INDEX payment_mpesa_code_unique
  ON payment (business_id, mpesa_code)
  WHERE mpesa_code IS NOT NULL AND duplicate_of_payment_id IS NULL;
