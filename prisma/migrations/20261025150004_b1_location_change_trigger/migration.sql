-- Hand-written (Phase B1): every insert, update or delete of a location
-- writes one change_log row in the same transaction. Reuses the generic
-- SECURITY INVOKER log_product_change() (see *_b1_pack_type_change_trigger).
CREATE TRIGGER location_change_log
  AFTER INSERT OR UPDATE OR DELETE ON location
  FOR EACH ROW EXECUTE FUNCTION log_product_change();
