-- ============================================================
-- 0033_relax_guru_api_token_constraint.sql
--
-- Relax `chk_workspace_integrations_guru_token_length` para aceitar formato
-- moderno do Digital Manager Guru.
--
-- Motivo: a constraint original (em 0028 ou similar) exige length=40 para o
-- campo `workspace_integrations.guru_api_token`. Esse formato refletia o
-- token "antigo" do Guru. O Guru atual emite o `api_token` (que vai dentro
-- do payload do webhook) ainda em 40 chars, MAS também emite tokens de API
-- REST no formato `<uuid>|<chave>` (~85 chars) usados em outros contextos.
-- Mantemos suporte aos dois formatos com `BETWEEN 16 AND 200`.
--
-- BR-WEBHOOK-001: token comparison segue timing-safe na app layer.
-- BR-PRIVACY-001: nunca logar valor do token.
--
-- Idempotente: ALTER TABLE DROP CONSTRAINT IF EXISTS antes de recriar.
-- ============================================================

ALTER TABLE workspace_integrations
  DROP CONSTRAINT IF EXISTS chk_workspace_integrations_guru_token_length;

ALTER TABLE workspace_integrations
  ADD CONSTRAINT chk_workspace_integrations_guru_token_length
  CHECK (guru_api_token IS NULL OR length(guru_api_token) BETWEEN 16 AND 200);
