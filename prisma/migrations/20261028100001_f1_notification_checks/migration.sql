-- Hand-written (Phase F1, docs/phase-f-design.md section 3): the database
-- checks of notification and error_event.

ALTER TABLE notification
  ADD CONSTRAINT notification_type_known
    CHECK (type IN ('sale.flagged', 'stock.converted', 'approval.used', 'settlement.variance', 'device.stale')),
  ADD CONSTRAINT notification_channel_known CHECK (channel IN ('IN_APP', 'PUSH', 'SMS', 'EMAIL')),
  ADD CONSTRAINT notification_status_known CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'DEAD')),
  ADD CONSTRAINT notification_attempts_not_negative CHECK (attempts >= 0),
  ADD CONSTRAINT notification_last_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 60),
  ADD CONSTRAINT notification_dedupe_key_length CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  -- data holds ids and counts: always a JSON object.
  ADD CONSTRAINT notification_data_object CHECK (jsonb_typeof(data) = 'object'),
  -- IN_APP rows are visible at once and never delivered; only they are read.
  ADD CONSTRAINT notification_in_app_sent CHECK (channel <> 'IN_APP' OR status = 'SENT'),
  ADD CONSTRAINT notification_read_in_app CHECK (read_at IS NULL OR channel = 'IN_APP'),
  -- sent_at exactly when SENT; a PENDING row always has its due time.
  ADD CONSTRAINT notification_sent_at_with_status CHECK ((status = 'SENT') = (sent_at IS NOT NULL)),
  ADD CONSTRAINT notification_pending_due CHECK (status <> 'PENDING' OR next_attempt_at IS NOT NULL);

ALTER TABLE error_event
  ADD CONSTRAINT error_event_source_length CHECK (char_length(source) BETWEEN 1 AND 60),
  ADD CONSTRAINT error_event_code_length CHECK (char_length(code) BETWEEN 1 AND 60),
  ADD CONSTRAINT error_event_detail_length CHECK (detail IS NULL OR char_length(detail) <= 200);
