-- Migration: add 'webhook:guru' to chk_events_event_source
-- Required by guru-raw-events-processor which sets event_source = 'webhook:guru'.
-- The constraint was defined in 0018_event_tables.sql without Guru support.
--
-- PostgreSQL check constraints on partitioned tables are inherited automatically;
-- we only need to drop/recreate on the parent table.

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Drop the constraint on the parent and all existing child partitions
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

-- Recreate on parent table (partitions inherit automatically in PG 14+)
ALTER TABLE events
  ADD CONSTRAINT chk_events_event_source CHECK (
    event_source IN (
      'tracker',
      'webhook:hotmart', 'webhook:kiwify', 'webhook:stripe',
      'webhook:webinarjam', 'webhook:typeform', 'webhook:tally',
      'webhook:guru',
      'redirector', 'system', 'admin'
    )
  ) NOT VALID;

-- Validate async (does not lock writes)
ALTER TABLE events VALIDATE CONSTRAINT chk_events_event_source;
