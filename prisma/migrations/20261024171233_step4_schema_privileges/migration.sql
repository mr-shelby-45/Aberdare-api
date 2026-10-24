-- Hand-written: schema-level privileges. They are also set by the Docker init
-- script, but `prisma migrate reset` drops and recreates the public schema
-- (owned by migrator, default privileges only), and a fresh hosted database
-- only gets what migrations contain. Without this app_user cannot see any
-- table (found in spike step 4). Safe to run when the grants already exist.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_user;
