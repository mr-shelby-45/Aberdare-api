-- Hand-written fix (Phase A1). In *_a1_identity_functions the REVOKE and GRANT
-- statements ran after ALTER FUNCTION ... OWNER TO identity_owner, as migrator,
-- which was then no longer the owner. Postgres does not fail in that case; it
-- only warns ("no privileges could be revoked") and changes nothing, so every
-- identity function stayed executable by PUBLIC. Found by the A1 privileges
-- test. Here the same statements run as the owner.
--
-- Lesson for every later migration: grant and revoke on a function BEFORE
-- handing it to another owner, or SET ROLE to that owner first.

SET ROLE identity_owner;

REVOKE EXECUTE ON FUNCTION identity_find_person_by_phone(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity_find_person_for_login(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity_record_password_attempt(uuid, boolean, timestamptz, integer, interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity_list_active_memberships(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity_find_invites_by_phone(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity_find_device(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity_list_device_members(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity_claim_refresh_token(text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity_ensure_person(text, timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION identity_find_person_by_phone(text) TO app_user;
GRANT EXECUTE ON FUNCTION identity_find_person_for_login(text) TO app_user;
GRANT EXECUTE ON FUNCTION identity_record_password_attempt(uuid, boolean, timestamptz, integer, interval) TO app_user;
GRANT EXECUTE ON FUNCTION identity_list_active_memberships(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION identity_find_invites_by_phone(text) TO app_user;
GRANT EXECUTE ON FUNCTION identity_find_device(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION identity_list_device_members(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION identity_claim_refresh_token(text, timestamptz) TO app_user;
GRANT EXECUTE ON FUNCTION identity_ensure_person(text, timestamptz) TO app_user;

RESET ROLE;
