-- 0052_lead_archived_status.sql
--
-- Adds 'archived' as a valid value for leads.status.
--
-- Status semantics:
--   active   — operational, visible in lists, counts, dashboards
--   merged   — combined into another lead (resolver follows merged_into_lead_id)
--   erased   — SAR/GDPR erasure (PII NULL, irreversible)
--   archived — user-hidden "soft delete" — data intact, reversible; excluded
--              from default lists/counts but kept in dashboard metrics so
--              historical revenue/ROAS doesn't shift retroactively.
--
-- Reversibility distinguishes archived from erased — see lib/lead-archive.ts
-- for the toggle helpers (archiveLead / unarchiveLead).

BEGIN;

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS chk_leads_status;

ALTER TABLE leads
  ADD CONSTRAINT chk_leads_status CHECK (
    status IN ('active', 'merged', 'erased', 'archived')
  );

COMMIT;
