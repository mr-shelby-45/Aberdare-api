-- Hand-written (Phase A4): marks a staff member's phone verified at
-- activation (docs/phase-a-design.md sections 5 and 6). Same rules as the
-- other identity functions: owned by identity_owner, SECURITY DEFINER, pinned
-- search_path with pg_temp last, STRICT, time passed in, executable only by
-- app_user. It needs no new grants: identity_owner already holds
-- person.phone_verified_at and otp_challenge.consumed_at (A2).

-- identity_owner needs CREATE on the schema only while it becomes the owner.
GRANT CREATE ON SCHEMA public TO identity_owner;

-- Consumes a verified STAFF_ACTIVATE code for exactly this person's phone and
-- marks the phone verified. Without that proof it changes nothing and
-- returns false.
CREATE FUNCTION identity_activate_phone(
  p_person_id uuid, p_challenge_id uuid, p_now timestamptz, p_proof_max_age interval)
RETURNS boolean
LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_phone text;
BEGIN
  SELECT p.phone INTO v_phone FROM person p WHERE p.id = p_person_id;
  IF v_phone IS NULL THEN
    RETURN false;
  END IF;

  UPDATE otp_challenge c
     SET consumed_at = p_now
   WHERE c.id = p_challenge_id
     AND c.channel = 'SMS'
     AND c.purpose = 'STAFF_ACTIVATE'
     AND c.target = v_phone
     AND c.verified_at IS NOT NULL
     AND c.verified_at > p_now - p_proof_max_age
     AND c.consumed_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE person p
     SET phone_verified_at = COALESCE(p.phone_verified_at, p_now)
   WHERE p.id = p_person_id;
  RETURN true;
END;
$$;

-- Execute rights while migrator still owns it (lesson from A1), then hand over.
REVOKE EXECUTE ON FUNCTION identity_activate_phone(uuid, uuid, timestamptz, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity_activate_phone(uuid, uuid, timestamptz, interval) TO app_user;
ALTER FUNCTION identity_activate_phone(uuid, uuid, timestamptz, interval) OWNER TO identity_owner;

REVOKE CREATE ON SCHEMA public FROM identity_owner;
