-- Hand-written (Phase F1, docs/phase-f-design.md section 3): error_event is
-- support-only and deliberately has NO row-level security, a narrow exception
-- to CLAUDE.md rule 1 that Ian decides on (see docs/phase-f-design.md).
--
-- Why that is safe: app_user may only INSERT. It has no SELECT, UPDATE or
-- DELETE, and no API route reads the table, so no business can read another's
-- rows through the application; support reads it as the migration role.
-- Why RLS would get in the way: the worker records failures that belong to no
-- business (the business list itself failed: business_id null) or that are
-- written after the failing business's transaction rolled back.
--
-- The application writes it with a plain INSERT, never INSERT ... RETURNING
-- (RETURNING would need SELECT).

GRANT INSERT ON error_event TO app_user;
