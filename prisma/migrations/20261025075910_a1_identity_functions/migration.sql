-- Hand-written (Phase A1): the identity functions of the non-tenant access
-- path (docs/phase-a-design.md section 5, docs/architecture.md section 3).
--
-- Every function:
--   - is SECURITY DEFINER and owned by identity_owner (NOLOGIN, not BYPASSRLS),
--     which reaches the tables only through its "TO identity_owner" policies
--     and column grants;
--   - pins search_path, with pg_temp last (otherwise the temp schema is
--     searched first);
--   - takes one exact key, has no dynamic SQL, and returns only the listed
--     columns for at most a handful of rows. None can list or search;
--   - is STRICT where every argument is a key, so a NULL key returns nothing;
--   - takes the time as p_now from the app's injectable clock, never now();
--   - can be executed by app_user only (EXECUTE revoked from PUBLIC).
--
-- Two functions use PL/pgSQL with two statements on purpose: under READ
-- COMMITTED a single statement keeps the snapshot it started with, so a
-- "claim, else explain why not" query in one statement misreports a row that
-- a concurrent transaction just changed.

-- identity_owner needs CREATE on the schema only while it becomes the owner of
-- the functions (ALTER FUNCTION ... OWNER TO checks it). Revoked at the end.
GRANT CREATE ON SCHEMA public TO identity_owner;

-- 1. Person by phone. Never returns a hash.
CREATE FUNCTION identity_find_person_by_phone(p_phone text)
RETURNS TABLE (person_id uuid, phone_verified boolean, email_verified boolean, has_password boolean)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p.id,
         p.phone_verified_at IS NOT NULL,
         p.email_verified_at IS NOT NULL,
         p.password_hash IS NOT NULL
  FROM person p
  WHERE p.phone = p_phone
$$;

-- 2. Owner login by email (compared lowercased). Only people with a password.
CREATE FUNCTION identity_find_person_for_login(p_email text)
RETURNS TABLE (person_id uuid, password_hash text, failed_login_count integer, login_locked_until timestamptz)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT p.id, p.password_hash, p.failed_login_count, p.login_locked_until
  FROM person p
  WHERE p.email = lower(p_email)
    AND p.password_hash IS NOT NULL
$$;

-- 3. Record a password attempt in one atomic statement. Failure: counter + 1,
--    and lock until p_now + p_lock_for once the counter reaches p_lock_after.
--    Success: counter 0, lock cleared. The limits come from the service.
CREATE FUNCTION identity_record_password_attempt(
  p_person_id uuid, p_succeeded boolean, p_now timestamptz,
  p_lock_after integer, p_lock_for interval)
RETURNS TABLE (failed_login_count integer, login_locked_until timestamptz)
LANGUAGE sql VOLATILE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  UPDATE person p
  SET failed_login_count = CASE WHEN p_succeeded THEN 0 ELSE p.failed_login_count + 1 END,
      login_locked_until = CASE
        WHEN p_succeeded THEN NULL
        WHEN p.failed_login_count + 1 >= p_lock_after THEN p_now + p_lock_for
        ELSE p.login_locked_until
      END
  WHERE p.id = p_person_id
  RETURNING p.failed_login_count, p.login_locked_until
$$;

-- 4. A person's ACTIVE memberships, with the business name (at most 50).
CREATE FUNCTION identity_list_active_memberships(p_person_id uuid)
RETURNS TABLE (membership_id uuid, business_id uuid, business_name text, role_preset text, status text)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.id, m.business_id, b.name, m.role_preset::text, m.status::text
  FROM membership m
  JOIN business b ON b.id = m.business_id
  WHERE m.person_id = p_person_id
    AND m.status = 'ACTIVE'
  ORDER BY b.name, m.id
  LIMIT 50
$$;

-- 5. INVITED memberships with a temp PIN, by phone (at most 20). Expired ones
--    are returned too: the service must answer them exactly like a wrong PIN.
CREATE FUNCTION identity_find_invites_by_phone(p_phone text)
RETURNS TABLE (membership_id uuid, business_id uuid, temp_pin_hash text,
               temp_pin_expires_at timestamptz, temp_pin_failed_count integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.id, m.business_id, m.temp_pin_hash, m.temp_pin_expires_at, m.temp_pin_failed_count
  FROM person p
  JOIN membership m ON m.person_id = p.id
  WHERE p.phone = p_phone
    AND m.status = 'INVITED'
    AND m.temp_pin_hash IS NOT NULL
  ORDER BY m.id
  LIMIT 20
$$;

-- 6. Device by id. The service compares the secret hash in constant time.
CREATE FUNCTION identity_find_device(p_device_id uuid)
RETURNS TABLE (device_id uuid, business_id uuid, secret_hash text, status text, is_shared boolean)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT d.id, d.business_id, d.secret_hash, d.status::text, d.is_shared
  FROM device d
  WHERE d.id = p_device_id
$$;

-- 7. Members of a shared device: names and ids only, ACTIVE memberships only,
--    and only when the device secret hash matches (at most 100).
CREATE FUNCTION identity_list_device_members(p_device_id uuid, p_secret_hash text)
RETURNS TABLE (membership_id uuid, display_name text)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT m.id, m.display_name
  FROM device d
  JOIN device_membership dm ON dm.business_id = d.business_id AND dm.device_id = d.id
  JOIN membership m ON m.business_id = dm.business_id AND m.id = dm.membership_id
  WHERE d.id = p_device_id
    AND d.secret_hash = p_secret_hash
    AND d.status = 'ACTIVE'
    AND d.is_shared
    AND m.status = 'ACTIVE'
  ORDER BY m.display_name, m.id
  LIMIT 100
$$;

-- 8. Claim a refresh token. Outcome CLAIMED (this call marked it used),
--    ALREADY_USED, REVOKED or EXPIRED. No row: unknown token.
CREATE FUNCTION identity_claim_refresh_token(p_token_hash text, p_now timestamptz)
RETURNS TABLE (refresh_token_id uuid, business_id uuid, membership_id uuid,
               device_id uuid, family_id uuid, outcome text)
LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- A concurrent claim of the same token waits here for the row lock, then
  -- re-checks used_at and finds it set, so exactly one caller gets CLAIMED.
  RETURN QUERY
    UPDATE refresh_token t
    SET used_at = p_now
    WHERE t.token_hash = p_token_hash
      AND t.used_at IS NULL
      AND t.revoked_at IS NULL
      AND t.expires_at > p_now
    RETURNING t.id, t.business_id, t.membership_id, t.device_id, t.family_id, 'CLAIMED'::text;
  IF FOUND THEN
    RETURN;
  END IF;
  -- A new statement, so it sees a claim another transaction just committed.
  RETURN QUERY
    SELECT t.id, t.business_id, t.membership_id, t.device_id, t.family_id,
           CASE
             WHEN t.revoked_at IS NOT NULL THEN 'REVOKED'
             WHEN t.used_at IS NOT NULL THEN 'ALREADY_USED'
             ELSE 'EXPIRED'
           END
    FROM refresh_token t
    WHERE t.token_hash = p_token_hash;
END;
$$;

-- 9. Create the person for a phone if there is none (staff invite). Never
--    changes an existing person. created = true only for the call that made it.
--    Attaching email, password and verified flags at signup is a separate
--    function in A2 that requires the consumed codes.
CREATE FUNCTION identity_ensure_person(p_phone text, p_now timestamptz)
RETURNS TABLE (person_id uuid, created boolean)
LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- A concurrent insert of the same phone waits here, then does nothing.
  RETURN QUERY
    INSERT INTO person (phone, created_at)
    VALUES (p_phone, p_now)
    ON CONFLICT (phone) DO NOTHING
    RETURNING person.id, true;
  IF FOUND THEN
    RETURN;
  END IF;
  -- A new statement, so it sees a person another transaction just committed.
  RETURN QUERY
    SELECT p.id, false
    FROM person p
    WHERE p.phone = p_phone;
END;
$$;

-- Ownership and execute rights, for every function above.
ALTER FUNCTION identity_find_person_by_phone(text) OWNER TO identity_owner;
ALTER FUNCTION identity_find_person_for_login(text) OWNER TO identity_owner;
ALTER FUNCTION identity_record_password_attempt(uuid, boolean, timestamptz, integer, interval) OWNER TO identity_owner;
ALTER FUNCTION identity_list_active_memberships(uuid) OWNER TO identity_owner;
ALTER FUNCTION identity_find_invites_by_phone(text) OWNER TO identity_owner;
ALTER FUNCTION identity_find_device(uuid) OWNER TO identity_owner;
ALTER FUNCTION identity_list_device_members(uuid, text) OWNER TO identity_owner;
ALTER FUNCTION identity_claim_refresh_token(text, timestamptz) OWNER TO identity_owner;
ALTER FUNCTION identity_ensure_person(text, timestamptz) OWNER TO identity_owner;

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

REVOKE CREATE ON SCHEMA public FROM identity_owner;
