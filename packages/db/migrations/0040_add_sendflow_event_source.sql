-- Migration: add 'webhook:sendflow' to chk_events_event_source
-- Required by sendflow-raw-events-processor which sets event_source = 'webhook:sendflow'.
-- Same pattern as 0030_add_guru_event_source.sql.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname, n.nspname, t.relname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'chk_events_event_source'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS chk_events_event_source',
      r.nspname, r.relname
    );
  END LOOP;
END;
$$;

ALTER TABLE events
  ADD CONSTRAINT chk_events_event_source CHECK (
    event_source IN (
      'tracker',
      'webhook:hotmart', 'webhook:kiwify', 'webhook:stripe',
      'webhook:webinarjam', 'webhook:typeform', 'webhook:tally',
      'webhook:guru', 'webhook:sendflow',
      'redirector', 'system', 'admin'
    )
  ) NOT VALID;

ALTER TABLE events VALIDATE CONSTRAINT chk_events_event_source;
