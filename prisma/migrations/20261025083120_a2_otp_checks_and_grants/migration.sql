-- Hand-written (Phase A2): checks and grants for otp_challenge, the signup
-- writer's person columns, and business inserts at signup
-- (docs/phase-a-design.md sections 4, 5 and 6).

-- ---------------------------------------------------------------- otp_challenge
-- Send limits are counted per exact target, so targets must be normalised:
-- an E.164 phone for SMS, a lowercase email for EMAIL.
ALTER TABLE otp_challenge
  ADD CONSTRAINT otp_challenge_target_normalised CHECK (
    (channel = 'SMS'   AND target ~ '^\+[1-9][0-9]{7,14}$')
    OR (channel = 'EMAIL' AND target = lower(target) AND target LIKE '%_@_%')
  );
ALTER TABLE otp_challenge
  ADD CONSTRAINT otp_challenge_attempts_not_negative CHECK (attempts >= 0);

-- No RLS (it holds nothing tenant-related) and no privileges for app_user:
-- like person, it is reached only through the identity functions.
GRANT SELECT (id, channel, target, purpose, code_hash, expires_at, attempts,
              verified_at, consumed_at, created_at)
  ON otp_challenge TO identity_owner;
GRANT INSERT (channel, target, purpose, code_hash, expires_at, created_at)
  ON otp_challenge TO identity_owner;
GRANT UPDATE (expires_at, attempts, verified_at, consumed_at)
  ON otp_challenge TO identity_owner;

-- ---------------------------------------------------------------- person
-- identity_complete_owner_signup sets these. app_user still cannot write person.
GRANT UPDATE (email, email_verified_at, phone_verified_at, password_hash, password_changed_at)
  ON person TO identity_owner;

-- ---------------------------------------------------------------- business
-- Signup creates the business under a tenant equal to its new id (the
-- shop_only policy checks it). No UPDATE or DELETE yet.
GRANT INSERT (id, name, type) ON business TO app_user;
