-- Hand-written (Phase T1, docs/phase-t-design.md section 3): one active field
-- location per member. Archived ones do not count, so a reassignment is
-- "archive the old location, create a new one". A partial index: Prisma
-- cannot declare it and does not try to drop it (listed in HAND_WRITTEN_INDEXES).
CREATE UNIQUE INDEX location_one_active_field_per_member
  ON location (business_id, assigned_membership_id)
  WHERE kind = 'FIELD' AND archived_at IS NULL;
