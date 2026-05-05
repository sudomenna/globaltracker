-- ============================================================
-- 20260505000033_relax_guru_api_token_constraint.sql
-- Mirror de packages/db/migrations/0033_relax_guru_api_token_constraint.sql
-- ============================================================

ALTER TABLE workspace_integrations
  DROP CONSTRAINT IF EXISTS chk_workspace_integrations_guru_token_length;

ALTER TABLE workspace_integrations
  ADD CONSTRAINT chk_workspace_integrations_guru_token_length
  CHECK (guru_api_token IS NULL OR length(guru_api_token) BETWEEN 16 AND 200);
