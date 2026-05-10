-- ============================================================
-- 0051_meta_audiences_mirror.sql
--
-- Meta Audiences Mirror: cache read-only de Custom Audiences do
-- Meta Ads, vinculadas a launches via config.metaCampaignPrefix.
--
-- Associação por inferência: o edge lê campanhas Meta cujo nome
-- começa com o prefixo do launch, extrai as audiences usadas nos
-- ad sets e faz upsert nesta tabela para exibição no Control Plane.
--
-- INV-META-AUDIENCE-001: (workspace_id, launch_id, meta_audience_id) único
-- INV-META-AUDIENCE-002: RLS — workspace members podem SELECT;
--   INSERT/UPDATE/DELETE apenas via service role
-- INV-META-AUDIENCE-003: launch_id nullable via ON DELETE SET NULL
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_audiences (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor (BR-RBAC-002)
  workspace_id                UUID NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,

  -- INV-META-AUDIENCE-003: nullable — cache persiste mesmo após exclusão do launch
  launch_id                   UUID
    REFERENCES launches(id) ON DELETE SET NULL,

  -- ID canônico da audience no Meta Ads (ex: "120245013791030082")
  meta_audience_id            TEXT NOT NULL,

  -- Nome da audience conforme API Meta
  name                        TEXT NOT NULL,

  -- Tipo: 'CUSTOM' | 'WEBSITE' | 'LOOKALIKE' | 'IG_BUSINESS'
  subtype                     TEXT NOT NULL,

  -- approximate_count_upper_bound da API Meta (nullable)
  approx_count                INTEGER,

  -- Código de status de entrega (200=pronto, 300=muito pequeno, etc.)
  delivery_status_code        INTEGER,

  -- Descrição textual do status de entrega (nullable)
  delivery_status_description TEXT,

  -- Timestamp da última sincronização com a API Meta
  synced_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- INV-META-AUDIENCE-001: garante upsert idempotente
-- (workspace_id, launch_id, meta_audience_id) é a chave natural de negócio
ALTER TABLE meta_audiences
  ADD CONSTRAINT uq_meta_audiences_workspace_launch_audience
  UNIQUE (workspace_id, launch_id, meta_audience_id);

COMMENT ON CONSTRAINT uq_meta_audiences_workspace_launch_audience
  ON meta_audiences IS 'INV-META-AUDIENCE-001: unicidade de audience por (workspace, launch, meta_audience_id). Permite ON CONFLICT DO UPDATE no ciclo de sincronização.';

-- Índice de suporte para queries por workspace + launch (listagem no CP)
CREATE INDEX idx_meta_audiences_workspace_launch
  ON meta_audiences (workspace_id, launch_id);

-- INV-META-AUDIENCE-002: RLS — apenas membros do workspace podem SELECT
-- INSERT/UPDATE/DELETE reservados ao service role (edge worker usa service role key)
ALTER TABLE meta_audiences ENABLE ROW LEVEL SECURITY;

CREATE POLICY meta_audiences_select_workspace_member
  ON meta_audiences
  FOR SELECT
  USING (workspace_id = (current_setting('app.current_workspace_id', true))::uuid);

-- Sem policy de INSERT/UPDATE/DELETE para roles de usuário:
-- o service role bypassa RLS por definição no Supabase/Postgres.

COMMENT ON TABLE meta_audiences IS
'Cache read-only de Custom Audiences do Meta Ads vinculadas a launches via config.metaCampaignPrefix. Populado pelo edge na sincronização periódica. Workspace members podem SELECT via RLS; escrita exclusiva do service role.';

COMMENT ON COLUMN meta_audiences.meta_audience_id IS
'ID da audience no Meta Ads (string numérica, ex: "120245013791030082"). Chave de upsert junto com workspace_id + launch_id.';

COMMENT ON COLUMN meta_audiences.subtype IS
'Tipo de audience conforme API Meta: CUSTOM | WEBSITE | LOOKALIKE | IG_BUSINESS.';

COMMENT ON COLUMN meta_audiences.approx_count IS
'approximate_count_upper_bound retornado pela API Meta. NULL quando não disponível (audiences muito novas ou sem permissão de leitura de tamanho).';

COMMENT ON COLUMN meta_audiences.delivery_status_code IS
'Código de status de entrega: 200=pronto, 300=muito pequeno para veiculação, etc. NULL antes da primeira verificação.';

COMMENT ON COLUMN meta_audiences.synced_at IS
'Timestamp da última sincronização bem-sucedida com a API Meta. Atualizado em todo upsert.';
