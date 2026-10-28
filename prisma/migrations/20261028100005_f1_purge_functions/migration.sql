-- Hand-written (Phase F1, docs/phase-f-design.md section 3): the only way
-- notification and error_event rows are deleted. Rows created before p_before,
-- across all businesses; returns the count. The cut-off comes from the caller
-- (the Clock minus the retention in config); nothing about 90 days is here.
-- Owned by the migration role, which owns both tables; for notification it
-- uses the owner policies of the f1_notification_rls migration (the
-- change_log_prune pattern). app_user still has no DELETE on either table.

CREATE FUNCTION purge_old_notifications(p_before timestamptz) RETURNS bigint
LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM notification WHERE created_at < p_before;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE FUNCTION purge_old_error_events(p_before timestamptz) RETURNS bigint
LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM error_event WHERE created_at < p_before;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

-- Grant while this role still owns the functions (here the owner never changes).
REVOKE ALL ON FUNCTION purge_old_notifications(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_old_error_events(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_old_notifications(timestamptz) TO app_user;
GRANT EXECUTE ON FUNCTION purge_old_error_events(timestamptz) TO app_user;
