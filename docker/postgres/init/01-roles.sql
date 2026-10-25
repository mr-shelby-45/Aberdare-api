-- Runs once, as the postgres superuser, when the data volume is first created.
--
-- migrator: owns the databases and the public schema, runs Prisma migrations.
-- app_user: used by the API, the worker and the tests. Not an owner, cannot
--           bypass RLS, cannot create anything. It has no table privileges
--           here; each migration grants exactly what the app needs per table.
-- identity_owner: no login. Owns only the identity lookup functions of the
--           non-tenant access path (docs/phase-a-design.md section 5).
--
-- On a hosted database an administrator runs the CREATE ROLE and GRANT
-- statements below once, by hand (this script does not run there).

\getenv migrator_password MIGRATOR_PASSWORD
\getenv app_user_password APP_USER_PASSWORD

CREATE ROLE migrator LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE ROLE app_user LOGIN PASSWORD :'app_user_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

CREATE ROLE identity_owner NOLOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

-- migrator must be able to hand functions to identity_owner
-- (ALTER FUNCTION ... OWNER TO needs SET), but must not inherit its
-- privileges or its RLS policies.
GRANT identity_owner TO migrator WITH INHERIT FALSE, SET TRUE;

-- aberdare: local development. aberdare_test: automated tests.
-- aberdare_shadow: scratch database Prisma uses to diff migrations.
CREATE DATABASE aberdare OWNER migrator;
CREATE DATABASE aberdare_test OWNER migrator;
CREATE DATABASE aberdare_shadow OWNER migrator;

REVOKE ALL ON DATABASE aberdare, aberdare_test, aberdare_shadow FROM PUBLIC;
GRANT CONNECT ON DATABASE aberdare, aberdare_test, aberdare_shadow TO migrator;
GRANT CONNECT ON DATABASE aberdare, aberdare_test TO app_user;

-- In Postgres 15+ the public schema is owned by the database owner (migrator)
-- and ordinary roles cannot create objects in it. app_user only needs USAGE.
\connect aberdare
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user;

\connect aberdare_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user;

\connect aberdare_shadow
REVOKE ALL ON SCHEMA public FROM PUBLIC;
