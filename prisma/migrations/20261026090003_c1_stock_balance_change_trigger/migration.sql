-- Hand-written (Phase C1): every change of a stock balance writes one
-- change_log row in the same transaction, so phones learn new quantities
-- through GET /sync/changes (Phase D).
--
-- Reuses the generic SECURITY INVOKER log_product_change(), like pack_type
-- and location: the log row passes the same RLS check as the change, and a
-- rolled-back change leaves no log row. It fires for both balance statements
-- (the strict conditional UPDATE and the upsert, whose conflict branch is an
-- UPDATE). DELETE is included as for the other tables, although app_user has
-- no DELETE on stock_balance; a maintenance delete would be logged too.
CREATE TRIGGER stock_balance_change_log
  AFTER INSERT OR UPDATE OR DELETE ON stock_balance
  FOR EACH ROW EXECUTE FUNCTION log_product_change();
