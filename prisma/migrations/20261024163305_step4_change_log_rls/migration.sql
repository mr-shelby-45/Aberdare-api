-- Hand-written: privileges and row-level security for change_log.

-- The product trigger runs as the user making the change (app_user), so
-- app_user needs INSERT. SELECT is for GET /sync/changes later. No UPDATE or
-- DELETE: the log is append-only.
GRANT SELECT, INSERT ON change_log TO app_user;
GRANT USAGE ON SEQUENCE change_log_id_seq TO app_user;

ALTER TABLE change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_log FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON change_log
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
