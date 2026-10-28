-- Hand-written (Phase F1): grants and row-level security of notification, the
-- step 1 pattern (ENABLE and FORCE, shop_only with NULLIF).
--
-- app_user: SELECT, INSERT, and UPDATE of the delivery and read columns only
-- (type, recipient, channel, data and dedupe key never change). No DELETE.
-- The owner (the migration role) gets read and delete policies of its own for
-- purge_old_notifications(), the change_log_prune pattern; app_user's
-- shop_only policy is unchanged.

GRANT SELECT, INSERT ON notification TO app_user;
GRANT UPDATE (status, attempts, next_attempt_at, last_error, sent_at, read_at) ON notification TO app_user;

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON notification
  USING (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);

CREATE POLICY owner_purge_read ON notification FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY owner_purge_delete ON notification FOR DELETE TO CURRENT_USER USING (true);
