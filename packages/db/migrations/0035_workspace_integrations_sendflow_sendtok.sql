-- ============================================================
-- 0035_workspace_integrations_sendflow_sendtok.sql
--
-- T-13-011 — SendFlow webhook inbound.
--
-- Adiciona coluna `sendflow_sendtok` na tabela `workspace_integrations`.
-- O `sendtok` é o segredo compartilhado emitido pelo SendFlow no painel,
-- enviado em todos os webhooks no header HTTP `sendtok` (sem prefixo
-- `Authorization` / `Bearer`). Constant-time compare na app layer
-- (apps/edge/src/routes/webhooks/sendflow.ts) — mesmo padrão do Guru
-- api_token.
--
-- Formato observado: 40 hex chars uppercase (ex: ADF590B72BCFCB64...).
-- Constraint permissiva (16-200) por segurança contra futura mudança
-- de formato pelo SendFlow — mesmo critério usado em 0033 pro Guru.
--
-- BR-PRIVACY-001: sendtok nunca logado, nunca em audit payloads, nunca em
--                 respostas de API. Constraint de length é metadata pública.
-- BR-WEBHOOK-001: validação no Edge antes de processar.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + DROP/ADD constraint.
-- ============================================================

ALTER TABLE workspace_integrations
  ADD COLUMN IF NOT EXISTS sendflow_sendtok TEXT;

ALTER TABLE workspace_integrations
  DROP CONSTRAINT IF EXISTS chk_workspace_integrations_sendflow_sendtok_length;

ALTER TABLE workspace_integrations
  ADD CONSTRAINT chk_workspace_integrations_sendflow_sendtok_length
  CHECK (
    sendflow_sendtok IS NULL
    OR (LENGTH(sendflow_sendtok) BETWEEN 16 AND 200)
  );

COMMENT ON COLUMN workspace_integrations.sendflow_sendtok IS
  'SendFlow webhook authentication token (header: sendtok). T-13-011. BR-PRIVACY-001: nunca logar valor.';
