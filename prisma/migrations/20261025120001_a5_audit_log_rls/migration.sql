-- Hand-written (Phase A5): checks, grants and row-level security for
-- audit_log (docs/phase-a-design.md sections 4 and 14).

-- Actions look like "staff.suspended": lowercase words, one dot.
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_action_format CHECK (action ~ '^[a-z_]+\.[a-z_]+$');
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_target_type_format CHECK (target_type ~ '^[a-z_]+$');
-- Metadata is always a JSON object, never an array or a bare value.
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_metadata_object CHECK (jsonb_typeof(metadata) = 'object');

-- Append-only: no UPDATE and no DELETE, so the API cannot rewrite history.
GRANT SELECT, INSERT ON audit_log TO app_user;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY shop_only ON audit_log
  USING      (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = NULLIF(current_setting('app.business_id', true), '')::uuid);
