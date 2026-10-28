-- Hand-written (Phase F1, docs/phase-f-design.md section 3): the worker's
-- only way to learn which businesses exist, before any tenant is known. Ids
-- only, in id order, paged by the caller (p_after null starts at the
-- beginning; p_limit is held to 1..1000). Each id is then processed in a normal
-- tenant transaction (TenantRunner); the worker never bypasses RLS.
--
-- Owner: identity_owner, the role of the non-tenant access path, which
-- already has SELECT on business(id) and the identity_read policy on it, so no
-- new privilege or policy is needed. Grants are given while the migration role
-- still owns the function, then it is handed over (CLAUDE.md: grant before you
-- hand over a function).

CREATE FUNCTION list_business_ids(p_after uuid, p_limit integer)
RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT b.id FROM business b
   WHERE p_after IS NULL OR b.id > p_after
   ORDER BY b.id
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000);
$$;

REVOKE ALL ON FUNCTION list_business_ids(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_business_ids(uuid, integer) TO app_user;
-- A new owner needs CREATE on the schema; given only for the hand-over and
-- taken back in this transaction (the a1_identity_functions pattern).
GRANT CREATE ON SCHEMA public TO identity_owner;
ALTER FUNCTION list_business_ids(uuid, integer) OWNER TO identity_owner;
REVOKE CREATE ON SCHEMA public FROM identity_owner;
