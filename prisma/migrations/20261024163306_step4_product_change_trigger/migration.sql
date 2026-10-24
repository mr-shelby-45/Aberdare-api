-- Hand-written: every insert, update or delete of a product writes one
-- change_log row in the same transaction. Prisma does not know about this.

-- SECURITY INVOKER (the default): runs as the user making the change, so the
-- change_log row passes the same RLS check as the product row itself.
CREATE FUNCTION log_product_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO change_log (business_id, table_name, row_id, operation)
    VALUES (OLD.business_id, TG_TABLE_NAME, OLD.id, TG_OP);
    RETURN OLD;
  END IF;
  INSERT INTO change_log (business_id, table_name, row_id, operation)
  VALUES (NEW.business_id, TG_TABLE_NAME, NEW.id, TG_OP);
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_change_log
  AFTER INSERT OR UPDATE OR DELETE ON product
  FOR EACH ROW EXECUTE FUNCTION log_product_change();
