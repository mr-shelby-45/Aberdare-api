-- Hand-written: trigram index for fuzzy product search (GET /products?q=,
-- docs/architecture.md section 7). pg_trgm is a trusted extension, so the
-- database owner (migrator) can install it without superuser rights.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX product_name_trgm_idx ON product USING gin (name gin_trgm_ops);
