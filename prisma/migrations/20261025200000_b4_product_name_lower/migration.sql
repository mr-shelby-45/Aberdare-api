-- Hand-written (Phase B4, approved by Ian as option B): a stored lowercase
-- copy of the product name, for search.
--
-- Why: under RLS, search cannot use an index for name ILIKE '%...%' (ILIKE is
-- not leakproof), so every search filters all of one business's products,
-- and ILIKE lowercases each name again on every search. Measured in the shadow
-- database with 20,000 products: name ILIKE 108.5 ms median, LIKE on this
-- stored column 18.0 ms, same results.
--
-- GENERATED ALWAYS ... STORED: Postgres computes it on every insert and
-- update and nothing can write it directly, so it can never disagree with
-- name. Declared in schema.prisma with @ignore so Prisma neither drops it nor
-- exposes it to the client. The table's existing grants cover the column
-- (app_user reads it; writing it is impossible for everyone).
--
-- Adding a stored generated column rewrites the table once; fine at this size.
ALTER TABLE product
  ADD COLUMN name_lower text GENERATED ALWAYS AS (lower(name)) STORED;
