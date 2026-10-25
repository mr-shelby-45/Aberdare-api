-- Hand-written (Phase A5): password reset for owners (docs/phase-a-design.md
-- sections 5 and 7). Same rules as the other identity functions: owned by
-- identity_owner, SECURITY DEFINER, pinned search_path with pg_temp last,
-- STRICT, time passed in, executable only by app_user. It needs no new
-- grants: identity_owner already holds person.password_hash,
-- password_changed_at, failed_login_count, login_locked_until (A1 and A2)
-- and otp_challenge.consumed_at (A2).

-- identity_owner needs CREATE on the schema only while it becomes the owner.
GRANT CREATE ON SCHEMA public TO identity_owner;

-- Consumes a verified PASSWORD_RESET email code for exactly this email and
-- sets the new password hash (made by the API, outside any transaction). It
-- also clears the password lockout, since the person proved who they are.
-- Without that proof it changes nothing and returns NULL. Returns the
-- person's id so the API can revoke their refresh tokens in every business.
-- Two statements on purpose: the challenge UPDATE claims the code once, even
-- when two resets race (the second finds consumed_at already set).
CREATE FUNCTION identity_reset_password(
  p_email text, p_challenge_id uuid, p_password_hash text,
  p_now timestamptz, p_proof_max_age interval)
RETURNS uuid
LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_person_id uuid;
BEGIN
  SELECT p.id INTO v_person_id FROM person p WHERE p.email = lower(p_email);
  IF v_person_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE otp_challenge c
     SET consumed_at = p_now
   WHERE c.id = p_challenge_id
     AND c.channel = 'EMAIL'
     AND c.purpose = 'PASSWORD_RESET'
     AND c.target = lower(p_email)
     AND c.verified_at IS NOT NULL
     AND c.verified_at > p_now - p_proof_max_age
     AND c.consumed_at IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE person p
     SET password_hash = p_password_hash,
         password_changed_at = p_now,
         failed_login_count = 0,
         login_locked_until = NULL
   WHERE p.id = v_person_id;
  RETURN v_person_id;
END;
$$;

-- Execute rights while migrator still owns it (lesson from A1), then hand over.
REVOKE EXECUTE ON FUNCTION identity_reset_password(text, uuid, text, timestamptz, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_reset_password(text, uuid, text, timestamptz, interval) TO app_user;
ALTER FUNCTION identity_reset_password(text, uuid, text, timestamptz, interval) OWNER TO identity_owner;

REVOKE CREATE ON SCHEMA public FROM identity_owner;
