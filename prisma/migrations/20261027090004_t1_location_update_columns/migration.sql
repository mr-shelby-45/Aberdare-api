-- Hand-written (Phase T1): app_user's table-wide UPDATE on location (spike
-- step 2) replaced by the columns the application writes: rename (name),
-- archive and restore (archived_at), and Prisma's updated_at. A location's
-- kind and assignee can then never change after creation; a field location is
-- reassigned by archiving it and creating a new one (docs/phase-t-design.md
-- section 2). The same pattern as *_d1_device_update_columns.
REVOKE UPDATE ON location FROM app_user;
GRANT UPDATE (name, archived_at, updated_at) ON location TO app_user;
