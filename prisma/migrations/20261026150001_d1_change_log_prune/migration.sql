-- Hand-written (Phase D1, docs/phase-d-design.md sections 3 and 7): the only
-- way change_log rows are ever deleted, and the record of how far that went.
--
-- Privilege choice (the smaller change): app_user gets EXECUTE on one narrow
-- SECURITY DEFINER function, and still has no DELETE on change_log. The
-- function runs as its owner, the migration role, which owns change_log.
-- change_log has FORCE ROW LEVEL SECURITY, which applies to the owner too, so
-- the owner gets two policies of its own (read and delete, every business);
-- app_user's shop_only policy is unchanged. No new role is needed.
--
-- The cut-off time comes from the caller (the application's Clock minus the
-- retention in config), not from SQL: nothing about 30 days is written here.

-- ---------------------------------------------------------------- horizon
-- Exactly one row, always present.
ALTER TABLE change_log_horizon
  ADD CONSTRAINT change_log_horizon_single_row CHECK (id = 1);
INSERT INTO change_log_horizon (id, pruned_through_txid, pruned_through_id, pruned_at)
VALUES (1, '0'::xid8, 0, now());

-- app_user reads it for the 410 rule; only change_log_prune() writes it.
GRANT SELECT ON change_log_horizon TO app_user;

-- ---------------------------------------------------------------- owner policies
CREATE POLICY owner_prune_read ON change_log FOR SELECT TO CURRENT_USER USING (true);
CREATE POLICY owner_prune_delete ON change_log FOR DELETE TO CURRENT_USER USING (true);

-- ---------------------------------------------------------------- prune
-- Deletes every change_log row written before p_before (all businesses), and
-- moves the horizon to the newest (txid, id) position it removed, never
-- backwards. Rows are chosen by time but the horizon is a position, so a
-- cursor is refused (410) whenever any row after it might have been removed.
-- The horizon row is locked first, so two prunes run one after the other.
-- Returns the number of rows removed.
CREATE FUNCTION change_log_prune(p_before timestamptz) RETURNS bigint
LANGUAGE plpgsql VOLATILE STRICT SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed bigint;
  newest_txid xid8;
  newest_id bigint;
BEGIN
  PERFORM 1 FROM change_log_horizon WHERE id = 1 FOR UPDATE;

  WITH gone AS (
    DELETE FROM change_log WHERE changed_at < p_before RETURNING txid, id
  )
  SELECT count(*),
         (SELECT g.txid FROM gone g ORDER BY g.txid DESC, g.id DESC LIMIT 1),
         (SELECT g.id FROM gone g ORDER BY g.txid DESC, g.id DESC LIMIT 1)
    INTO removed, newest_txid, newest_id
    FROM gone;

  IF removed > 0 THEN
    UPDATE change_log_horizon
       SET pruned_through_txid = newest_txid,
           pruned_through_id = newest_id,
           pruned_at = now()
     WHERE id = 1
       AND (pruned_through_txid, pruned_through_id) < (newest_txid, newest_id);
  END IF;
  RETURN removed;
END;
$$;

-- Grant while this role still owns the function (CLAUDE.md: grant before
-- you hand over a function; here the owner never changes).
REVOKE ALL ON FUNCTION change_log_prune(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION change_log_prune(timestamptz) TO app_user;
