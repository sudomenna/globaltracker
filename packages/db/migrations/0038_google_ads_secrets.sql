-- ============================================================
-- 0038_google_ads_secrets.sql
--
-- T-14-002 — Google Ads OAuth secrets (duas colunas em duas tabelas).
-- Sprint 14 — Fanout Google Ads/GA4/Enhanced Conversions.
--
-- ADR-028 (refinado 2026-05-06): refresh_token criptografado em coluna
-- dedicada workspace_integrations.google_ads_refresh_token_enc, padrão
-- consistente com guru_api_token e sendflow_sendtok. Developer token
-- plain em workspaces.google_ads_developer_token (credencial do operador
-- GlobalTracker, compartilhável; pode também vir de env var
-- GOOGLE_ADS_DEVELOPER_TOKEN como fallback global).
--
-- BR-PRIVACY-001:
--   - refresh_token cru NUNCA entra em logs ou em respostas API.
--   - developer_token é credencial do operador (não do tenant) — também
--     não logar; respostas API mascaram.
--
-- depends-on: 0037_external_pii_hashes.sql
-- ============================================================

-- 1. workspace_integrations.google_ads_refresh_token_enc
--    Format: AES-256-GCM, key = HKDF(PII_MASTER_KEY_V1, salt=workspace_id),
--            serialização compatível com encryptPii()/decryptPii() em
--            apps/edge/src/lib/pii.ts.
--    Length cru ~150-300 chars; encriptado base64 ~250-500 chars; constraint
--    amplo (50-2048).
ALTER TABLE workspace_integrations
  ADD COLUMN IF NOT EXISTS google_ads_refresh_token_enc TEXT;

ALTER TABLE workspace_integrations
  DROP CONSTRAINT IF EXISTS chk_workspace_integrations_google_ads_refresh_token_enc_length;

ALTER TABLE workspace_integrations
  ADD CONSTRAINT chk_workspace_integrations_google_ads_refresh_token_enc_length
  CHECK (
    google_ads_refresh_token_enc IS NULL
    OR (LENGTH(google_ads_refresh_token_enc) BETWEEN 50 AND 2048)
  );

COMMENT ON COLUMN workspace_integrations.google_ads_refresh_token_enc IS
  'Google Ads OAuth refresh_token, criptografado AES-256-GCM workspace-scoped via PII_MASTER_KEY_V1+HKDF. Format compatível com encryptPii()/decryptPii(). T-14-002 / ADR-028 refinado. BR-PRIVACY-001: nunca logar valor.';

-- 2. workspaces.google_ads_developer_token
--    Plain text — credencial do operador GlobalTracker (não do tenant).
--    Pode também ser fornecida via env var GOOGLE_ADS_DEVELOPER_TOKEN como
--    fallback global. Formato Google é geralmente ~22 chars; constraint
--    conservado amplo (5-1024) contra futura mudança.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS google_ads_developer_token TEXT;

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS chk_workspaces_google_ads_developer_token_length;

ALTER TABLE workspaces
  ADD CONSTRAINT chk_workspaces_google_ads_developer_token_length
  CHECK (
    google_ads_developer_token IS NULL
    OR (LENGTH(google_ads_developer_token) BETWEEN 5 AND 1024)
  );

COMMENT ON COLUMN workspaces.google_ads_developer_token IS
  'Google Ads developer token (plain text). Credencial do operador GlobalTracker, compartilhável entre workspaces. Quando NULL, runtime usa env var GOOGLE_ADS_DEVELOPER_TOKEN. T-14-002 / ADR-028 refinado. BR-PRIVACY-001: não logar; respostas API mascaram.';
