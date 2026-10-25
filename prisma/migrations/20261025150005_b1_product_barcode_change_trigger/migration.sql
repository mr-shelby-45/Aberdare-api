-- Hand-written (Phase B1): every insert, update or delete of a barcode writes
-- one change_log row in the same transaction, with the barcode text in
-- row_key. Phones add barcodes by code (barcode.add has no id), so on a
-- delete the code is what lets a phone find and remove its own copy; the row
-- itself is gone by then.
--
-- SECURITY INVOKER (the default), like log_product_change(): the log row
-- passes the same RLS check as the change, and a rolled-back change leaves
-- no log row. Its own function because it also fills row_key.
CREATE FUNCTION log_product_barcode_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO change_log (business_id, table_name, row_id, row_key, operation)
    VALUES (OLD.business_id, TG_TABLE_NAME, OLD.id, OLD.barcode, TG_OP);
    RETURN OLD;
  END IF;
  INSERT INTO change_log (business_id, table_name, row_id, row_key, operation)
  VALUES (NEW.business_id, TG_TABLE_NAME, NEW.id, NEW.barcode, TG_OP);
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_barcode_change_log
  AFTER INSERT OR UPDATE OR DELETE ON product_barcode
  FOR EACH ROW EXECUTE FUNCTION log_product_barcode_change();
