-- Hand-written partial unique index: a product has at most one base unit
-- (a pack type with units_per_pack = 1, the "piece"), so break bulk always
-- knows which pool the pieces go to. Other pack types are not limited.
CREATE UNIQUE INDEX pack_type_one_base_unit_per_product
  ON pack_type (business_id, product_id)
  WHERE units_per_pack = 1;
