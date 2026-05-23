-- ============================================================
-- 0056_recovery_campaign_sent_tag.sql
--
-- T-RECOVERY-FIX-001 — Adiciona `unnichat_sent_tag_id` em
-- recovery_campaigns + seed do valor para a campanha de produção.
--
-- Contexto:
--   Após um envio bem-sucedido (recovery_job.status='sent'), o contato
--   deve receber uma tag na Unnichat via:
--       POST /api/contact/{id}/tags
--   O ID da tag é POR-CAMPANHA/POR-LAUNCH (cada lançamento tem sua tag
--   de "abordado no recovery"), portanto vive na própria campaign — não
--   no template (compartilhável) nem global.
--
--   Coluna nullable: campanha sem tag configurada simplesmente NÃO
--   tagueia o contato após o envio (o sender pula o POST).
--
-- Aplicação:
--   USER APLICA MANUALMENTE VIA PSQL — mesmo padrão das migrations 0053,
--   0054 e 0055. Drizzle-kit migrate ESM continua quebrado no monorepo
--   (ver MEMORY.md). O schema Drizzle TS em
--   packages/db/src/schema/recovery_campaign.ts espelha 1:1 esta coluna.
--
-- BRs / INVs aplicáveis:
--   BR-RBAC-002:   coluna vive em tabela já workspace-scoped + RLS (sem
--                  alteração de RLS necessária — só ADD COLUMN).
--   BR-PRIVACY-001: tag_id é identificador opaco da Unnichat, sem PII.
--
-- Idempotência:
--   ADD COLUMN IF NOT EXISTS + UPDATE filtrado (re-run = noop / no-op
--   após primeiro UPDATE). Sem ON CONFLICT pois é UPDATE, não INSERT.
-- ============================================================

-- ============================================================
-- 1. ADD COLUMN — recovery_campaigns.unnichat_sent_tag_id
-- ============================================================
ALTER TABLE recovery_campaigns
  ADD COLUMN IF NOT EXISTS unnichat_sent_tag_id text;

COMMENT ON COLUMN recovery_campaigns.unnichat_sent_tag_id IS
  'ID da tag Unnichat aplicada ao contato via POST /api/contact/{id}/tags APÓS um envio com status=''sent''. Por-campanha/por-launch. NULL = campanha não tagueia o contato após o envio.';

-- ============================================================
-- 2. SEED — tag da campanha de produção (wcs_jun26_bait_abandono).
--    UPDATE filtrado por workspace_id + name (idempotente).
-- ============================================================
UPDATE recovery_campaigns
   SET unnichat_sent_tag_id = '019e5734-416c-774c-a86c-d1d570a96249'
 WHERE workspace_id = '74860330-a528-4951-bf49-90f0b5c72521'
   AND name = 'wcs_jun26_bait_abandono';

-- Down (manual rollback):
-- ALTER TABLE recovery_campaigns DROP COLUMN IF EXISTS unnichat_sent_tag_id;
