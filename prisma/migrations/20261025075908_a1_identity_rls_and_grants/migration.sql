-- Hand-written (Phase A1): checks, row-level security and grants for the
-- identity tables and business (docs/phase-a-design.md sections 4 and 5).
-- Grants are by column where possible: "grant columns, not tables".

-- ---------------------------------------------------------------- checks
-- E.164: "+", a non-zero digit, 7 to 14 more digits.
ALTER TABLE person
  ADD CONSTRAINT person_phone_e164 CHECK (phone ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE person
  ADD CONSTRAINT person_email_lowercase CHECK (email IS NULL OR email = lower(email));

-- ---------------------------------------------------------------- business
-- The tenant is its own row. Signup will set the tenant to the new id first.
ALTER TABLE business ENABLE ROW LEVEL SECURITY;
ALTER TABLE business FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON business
  USING      (id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.business_id', true), '')::uuid);

CREATE POLICY identity_read ON business FOR SELECT TO identity_owner USING (true);

-- app_user keeps SELECT only (granted in step 1); INSERT comes with signup (A2).
GRANT SELECT (id, name) ON business TO identity_owner;

-- ---------------------------------------------------------------- person
ALTER TABLE person ENABLE ROW LEVEL SECURITY;
ALTER TABLE person FORCE ROW LEVEL SECURITY;

-- app_user sees a person only when that person has a membership in the
-- current business. The membership subquery is itself under shop_only RLS.
CREATE POLICY member_of_current_business ON person FOR SELECT TO app_user
  USING (EXISTS (
    SELECT 1 FROM membership m
    WHERE m.person_id = person.id
      AND m.business_id = NULLIF(current_setting('app.business_id', true), '')::uuid));

CREATE POLICY identity_read   ON person FOR SELECT TO identity_owner USING (true);
CREATE POLICY identity_insert ON person FOR INSERT TO identity_owner WITH CHECK (true);
CREATE POLICY identity_update ON person FOR UPDATE TO identity_owner USING (true) WITH CHECK (true);

-- Never the password or lock columns, and no writes: those go through the
-- identity functions.
GRANT SELECT (id, phone, phone_verified_at, email, email_verified_at, created_at)
  ON person TO app_user;

GRANT SELECT (id, phone, phone_verified_at, email, email_verified_at, password_hash,
              failed_login_count, login_locked_until)
  ON person TO identity_owner;
GRANT INSERT (phone, created_at) ON person TO identity_owner;
GRANT UPDATE (failed_login_count, login_locked_until) ON person TO identity_owner;

-- ---------------------------------------------------------------- membership
ALTER TABLE membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON membership
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
CREATE POLICY identity_read ON membership FOR SELECT TO identity_owner USING (true);

-- No DELETE: removing staff sets status REMOVED.
GRANT SELECT, INSERT, UPDATE ON membership TO app_user;
GRANT SELECT (id, business_id, person_id, display_name, role_preset, status,
              temp_pin_hash, temp_pin_expires_at, temp_pin_failed_count)
  ON membership TO identity_owner;

-- ---------------------------------------------------------------- device
ALTER TABLE device ENABLE ROW LEVEL SECURITY;
ALTER TABLE device FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON device
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
CREATE POLICY identity_read ON device FOR SELECT TO identity_owner USING (true);

-- No DELETE: revoking sets status REVOKED.
GRANT SELECT, INSERT, UPDATE ON device TO app_user;
GRANT SELECT (id, business_id, secret_hash, status, is_shared) ON device TO identity_owner;

-- ---------------------------------------------------------------- device_membership
ALTER TABLE device_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_membership FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON device_membership
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
-- Added to the design's list: identity_list_device_members needs it.
CREATE POLICY identity_read ON device_membership FOR SELECT TO identity_owner USING (true);

-- DELETE: taking someone off a shared tablet removes the link.
GRANT SELECT, INSERT, DELETE ON device_membership TO app_user;
GRANT SELECT (business_id, device_id, membership_id) ON device_membership TO identity_owner;

-- ---------------------------------------------------------------- refresh_token
ALTER TABLE refresh_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_token FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON refresh_token
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
CREATE POLICY identity_read  ON refresh_token FOR SELECT TO identity_owner USING (true);
CREATE POLICY identity_claim ON refresh_token FOR UPDATE TO identity_owner USING (true) WITH CHECK (true);

-- No DELETE: revoking sets revoked_at.
GRANT SELECT, INSERT, UPDATE ON refresh_token TO app_user;
GRANT SELECT (id, business_id, membership_id, device_id, family_id, token_hash,
              expires_at, used_at, revoked_at)
  ON refresh_token TO identity_owner;
GRANT UPDATE (used_at) ON refresh_token TO identity_owner;
