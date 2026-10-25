-- Hand-written (Phase A2): identity functions for codes and owner signup
-- (docs/phase-a-design.md sections 5, 6 and 10). Same rules as A1: owned by
-- identity_owner, SECURITY DEFINER, pinned search_path with pg_temp last, one
-- exact key, STRICT, time passed in as p_now, executable only by app_user.
--
-- Order matters (lesson from A1): create, then REVOKE/GRANT while migrator is
-- still the owner, and only then ALTER ... OWNER TO identity_owner. Postgres
-- carries the existing grants over to the new owner.

-- identity_owner needs CREATE on the schema only while it becomes the owner.
GRANT CREATE ON SCHEMA public TO identity_owner;

-- A. Create a code, enforcing the send limits. Limits count every purpose for
--    the target (so mixing purposes cannot multiply SMS). A per-target lock
--    stops two concurrent requests from both passing the limits. Older live
--    codes for the same target and purpose stop working.
CREATE FUNCTION identity_create_otp_challenge(
  p_channel otp_channel, p_target text, p_purpose otp_purpose, p_code_hash text,
  p_now timestamptz, p_ttl interval, p_min_gap interval,
  p_max_per_hour integer, p_max_per_day integer)
RETURNS TABLE (challenge_id uuid, outcome text)
LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_last timestamptz;
  v_last_hour integer;
  v_last_day integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('otp_challenge:' || p_target, 0));

  SELECT max(c.created_at),
         count(*) FILTER (WHERE c.created_at > p_now - interval '1 hour'),
         count(*)
    INTO v_last, v_last_hour, v_last_day
    FROM otp_challenge c
   WHERE c.target = p_target
     AND c.created_at > p_now - interval '1 day';

  IF v_last IS NOT NULL AND v_last > p_now - p_min_gap THEN
    RETURN QUERY SELECT NULL::uuid, 'TOO_SOON'::text;
    RETURN;
  END IF;
  IF v_last_hour >= p_max_per_hour THEN
    RETURN QUERY SELECT NULL::uuid, 'HOURLY_LIMIT'::text;
    RETURN;
  END IF;
  IF v_last_day >= p_max_per_day THEN
    RETURN QUERY SELECT NULL::uuid, 'DAILY_LIMIT'::text;
    RETURN;
  END IF;

  UPDATE otp_challenge c
     SET expires_at = p_now
   WHERE c.target = p_target
     AND c.purpose = p_purpose
     AND c.consumed_at IS NULL
     AND c.expires_at > p_now;

  RETURN QUERY
    INSERT INTO otp_challenge (channel, target, purpose, code_hash, expires_at, created_at)
    VALUES (p_channel, p_target, p_purpose, p_code_hash, p_now + p_ttl, p_now)
    RETURNING otp_challenge.id, 'CREATED'::text;
END;
$$;

-- B. Check a code in one atomic statement: attempts + 1 on the latest
--    unconsumed code for this target and purpose, and mark it verified only if
--    the hash matches, it has not expired and attempts <= p_max_attempts.
--    The hashes compared are HMACs keyed with the server pepper; without the
--    pepper nothing can be learned from how long the comparison takes (an
--    intended exception to "constant-time compare in JavaScript", approved by
--    Ian). Concurrent guesses wait on the row lock, so every one is counted.
--    No row back: there is no unconsumed code (never sent, or already used).
CREATE FUNCTION identity_verify_otp(
  p_channel otp_channel, p_target text, p_purpose otp_purpose, p_code_hash text,
  p_now timestamptz, p_max_attempts integer)
RETURNS TABLE (challenge_id uuid, outcome text)
LANGUAGE sql VOLATILE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  UPDATE otp_challenge c
     SET attempts = c.attempts + 1,
         verified_at = CASE
           WHEN c.verified_at IS NOT NULL THEN c.verified_at
           WHEN c.code_hash = p_code_hash
                AND c.attempts + 1 <= p_max_attempts
                AND c.expires_at > p_now THEN p_now
           ELSE NULL
         END
   WHERE c.id = (
     SELECT x.id
       FROM otp_challenge x
      WHERE x.channel = p_channel
        AND x.target = p_target
        AND x.purpose = p_purpose
        AND x.consumed_at IS NULL
      ORDER BY x.created_at DESC, x.id DESC
      LIMIT 1
      FOR UPDATE)
  RETURNING c.id,
    CASE
      WHEN c.code_hash = p_code_hash AND c.verified_at IS NOT NULL THEN 'VERIFIED'
      WHEN c.expires_at <= p_now THEN 'EXPIRED'
      WHEN c.attempts > p_max_attempts THEN 'TOO_MANY_ATTEMPTS'
      ELSE 'INVALID'
    END
$$;

-- C. The signup writer. Does nothing unless both challenges are verified,
--    unconsumed, recent, purpose SIGNUP, and for exactly this phone and email.
--    Checks for an existing account before writing anything, then consumes
--    both codes and creates or completes the person.
--    PROOF_INVALID and ACCOUNT_EXISTS write nothing. CREATED: new person.
--    UPGRADED: an existing person without a password (for example a staff
--    invite), who keeps their memberships.
CREATE FUNCTION identity_complete_owner_signup(
  p_phone text, p_email text, p_password_hash text,
  p_phone_challenge_id uuid, p_email_challenge_id uuid,
  p_now timestamptz, p_proof_max_age interval)
RETURNS TABLE (person_id uuid, outcome text)
LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_email text := lower(p_email);
  v_proofs integer;
  v_inserted uuid;
  v_person uuid;
BEGIN
  -- Lock both proofs. A concurrent signup with the same proofs waits here and
  -- then finds them consumed.
  SELECT count(*) INTO v_proofs
    FROM (
      SELECT c.id
        FROM otp_challenge c
       WHERE c.purpose = 'SIGNUP'
         AND c.consumed_at IS NULL
         AND c.verified_at IS NOT NULL
         AND c.verified_at > p_now - p_proof_max_age
         AND ((c.id = p_phone_challenge_id AND c.channel = 'SMS' AND c.target = p_phone)
           OR (c.id = p_email_challenge_id AND c.channel = 'EMAIL' AND c.target = v_email))
       FOR UPDATE
    ) proofs;
  IF v_proofs <> 2 THEN
    RETURN QUERY SELECT NULL::uuid, 'PROOF_INVALID'::text;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM person p
     WHERE (p.phone = p_phone AND p.password_hash IS NOT NULL)
        OR (p.email = v_email AND p.phone <> p_phone)
  ) THEN
    RETURN QUERY SELECT NULL::uuid, 'ACCOUNT_EXISTS'::text;
    RETURN;
  END IF;

  UPDATE otp_challenge c
     SET consumed_at = p_now
   WHERE c.id IN (p_phone_challenge_id, p_email_challenge_id);

  INSERT INTO person (phone, created_at)
  VALUES (p_phone, p_now)
  ON CONFLICT (phone) DO NOTHING
  RETURNING person.id INTO v_inserted;

  -- A new statement, so it sees a person another transaction just committed.
  UPDATE person p
     SET email = v_email,
         email_verified_at = p_now,
         phone_verified_at = COALESCE(p.phone_verified_at, p_now),
         password_hash = p_password_hash,
         password_changed_at = p_now
   WHERE p.phone = p_phone
     AND p.password_hash IS NULL
  RETURNING p.id INTO v_person;

  IF v_person IS NULL THEN
    -- A concurrent signup gave this phone a password after the check above.
    -- Fail so the caller's transaction (including the consumed codes) rolls back.
    RAISE EXCEPTION 'account already exists for this phone' USING ERRCODE = 'unique_violation';
  END IF;

  RETURN QUERY SELECT v_person, CASE WHEN v_inserted IS NOT NULL THEN 'CREATED' ELSE 'UPGRADED' END;
END;
$$;

-- Execute rights while migrator still owns the functions, then hand them over.
REVOKE EXECUTE ON FUNCTION identity_create_otp_challenge(otp_channel, text, otp_purpose, text, timestamptz, interval, interval, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity_verify_otp(otp_channel, text, otp_purpose, text, timestamptz, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION identity_complete_owner_signup(text, text, text, uuid, uuid, timestamptz, interval) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION identity_create_otp_challenge(otp_channel, text, otp_purpose, text, timestamptz, interval, interval, integer, integer) TO app_user;
GRANT EXECUTE ON FUNCTION identity_verify_otp(otp_channel, text, otp_purpose, text, timestamptz, integer) TO app_user;
GRANT EXECUTE ON FUNCTION identity_complete_owner_signup(text, text, text, uuid, uuid, timestamptz, interval) TO app_user;

ALTER FUNCTION identity_create_otp_challenge(otp_channel, text, otp_purpose, text, timestamptz, interval, interval, integer, integer) OWNER TO identity_owner;
ALTER FUNCTION identity_verify_otp(otp_channel, text, otp_purpose, text, timestamptz, integer) OWNER TO identity_owner;
ALTER FUNCTION identity_complete_owner_signup(text, text, text, uuid, uuid, timestamptz, interval) OWNER TO identity_owner;

REVOKE CREATE ON SCHEMA public FROM identity_owner;
