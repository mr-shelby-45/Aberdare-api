-- Hand-written (Phase E1, docs/phase-e-design.md section 3): every insert or
-- update of a sale row writes one change_log row in the same transaction, so
-- phones learn of it through GET /v1/sync/changes (from Phase E4). Reuses the
-- generic SECURITY INVOKER log_product_change(), like the catalogue and stock
-- tables: the log row passes the same RLS check as the change, and a rolled-
-- back change leaves no log row. No DELETE: app_user cannot delete sale rows.
CREATE TRIGGER sale_change_log
  AFTER INSERT OR UPDATE ON sale
  FOR EACH ROW EXECUTE FUNCTION log_product_change();
