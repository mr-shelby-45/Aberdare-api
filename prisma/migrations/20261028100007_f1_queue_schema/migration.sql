-- Hand-written (Phase F1, docs/phase-f-design.md section 3): the schema for
-- pg-boss and the privileges of its runtime role.
--
-- Roles:
-- * migrator (this migration, and `pnpm queue:migrate` right after
--   `prisma migrate deploy`) creates the pgboss schema and every pg-boss object
--   in it. pg-boss creates and upgrades its own tables as migrator, never at
--   runtime.
-- * queue_user (LOGIN, created like the other roles: by the init script
--   locally, by an administrator on a hosted database) is the role pg-boss
--   connects as in the worker. It may read and write pg-boss's tables and run
--   its functions, and nothing else: it has no USAGE on public, so it cannot
--   reach any business table, and it cannot create objects.
-- * app_user never touches pgboss (no USAGE on it).
--
-- Default privileges make every object migrator later creates in pgboss
-- (now and in pg-boss upgrades) usable by queue_user without another grant.
-- MAINTAIN (Postgres 17+) lets pg-boss rebuild bloated job indexes (REINDEX)
-- without owning them.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'queue_user') THEN
    RAISE EXCEPTION 'Role queue_user is missing. Create it first (docker/postgres/init/01-roles.sql shows the statement).';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO queue_user', current_database());
END;
$$;

CREATE SCHEMA pgboss;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
GRANT USAGE ON SCHEMA pgboss TO queue_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE, MAINTAIN ON TABLES TO queue_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO queue_user;
-- Postgres gives PUBLIC EXECUTE on every new function, and a per-schema
-- default cannot take that away (per-schema defaults only add). The gate is
-- the schema: only queue_user has USAGE on pgboss, so no other role can reach
-- pg-boss's functions or tables (checked by the F1 privileges test).
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO queue_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE ON TYPES TO queue_user;
