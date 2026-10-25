-- Hand-written (Phase A1): the identity_owner role must exist before the
-- identity functions can be created. Roles are not created by migrations
-- (they live in docker/postgres/init/01-roles.sql locally, and are created
-- by hand on a hosted database), so stop here with a clear message if missing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_owner') THEN
    RAISE EXCEPTION 'Role identity_owner is missing. Create it as in docker/postgres/init/01-roles.sql before migrating.';
  END IF;
  IF NOT pg_has_role('migrator', 'identity_owner', 'SET') THEN
    RAISE EXCEPTION 'migrator must be granted identity_owner WITH SET TRUE (see docker/postgres/init/01-roles.sql).';
  END IF;
END $$;

-- The identity functions read tables in this schema.
GRANT USAGE ON SCHEMA public TO identity_owner;
