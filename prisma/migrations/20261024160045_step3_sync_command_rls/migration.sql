-- Hand-written: checks, app_user privileges and row-level security for
-- sync_command. Prisma does not generate or understand any of this.

-- result is filled in exactly when the command has an outcome.
ALTER TABLE sync_command
  ADD CONSTRAINT sync_command_result_when_done
  CHECK ((status = 'PROCESSING') = (result IS NULL));

-- UPDATE is needed once per command, inside the transaction that inserted it
-- (PROCESSING -> outcome). No DELETE.
GRANT SELECT, INSERT, UPDATE ON sync_command TO app_user;

ALTER TABLE sync_command ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_command FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON sync_command
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

-- Restrictive: applies on top of shop_only. A row can only be updated while it
-- is still PROCESSING, so a stored outcome can never be rewritten later.
-- WITH CHECK (true) is required: without it Postgres reuses USING for the new
-- row, which would block the PROCESSING -> outcome update itself.
CREATE POLICY outcome_is_final ON sync_command
  AS RESTRICTIVE
  FOR UPDATE
  USING (status = 'PROCESSING')
  WITH CHECK (true);
