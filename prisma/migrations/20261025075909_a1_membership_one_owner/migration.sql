-- Hand-written partial unique index (Phase A1): exactly one OWNER membership
-- per business (docs/phase-a-design.md section 4). Prisma cannot express a
-- partial index, so it ignores this one.
CREATE UNIQUE INDEX membership_one_owner_per_business
  ON membership (business_id)
  WHERE role_preset = 'OWNER';
