-- Hand-written (Phase D1, docs/phase-d-design.md section 3): app_user may
-- update only the device columns the application writes. Until now it had
-- UPDATE on the whole table (Phase A1).
--   name, is_shared   rename and shared flag (team module, A4)
--   status            revoke (A4)
--   last_seen_at      PIN login (A3)
--   last_sync_at      the sync stamp (D1; the column has existed since A1, unused)
-- No longer updatable by app_user: id, business_id, platform, secret_hash,
-- registered_by_membership_id, push_token (Phase F adds it when it is used),
-- created_at. INSERT and SELECT are unchanged.
REVOKE UPDATE ON device FROM app_user;
GRANT UPDATE (name, is_shared, status, last_seen_at, last_sync_at) ON device TO app_user;
