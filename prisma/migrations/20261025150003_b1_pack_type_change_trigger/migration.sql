-- Hand-written (Phase B1): every insert, update or delete of a pack type
-- writes one change_log row in the same transaction.
--
-- Reuses log_product_change() from *_step4_product_change_trigger: despite
-- its name it is generic (it logs TG_TABLE_NAME and the row's id) and
-- SECURITY INVOKER, so the log row passes the same RLS check as the change
-- and a rolled-back change leaves no log row.
CREATE TRIGGER pack_type_change_log
  AFTER INSERT OR UPDATE OR DELETE ON pack_type
  FOR EACH ROW EXECUTE FUNCTION log_product_change();
