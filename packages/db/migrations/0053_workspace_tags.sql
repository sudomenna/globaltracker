-- ============================================================
-- 0053_workspace_tags.sql
--
-- T-TAGS-001 — Catálogo de metadados de tags por workspace.
--
-- Cria a tabela `workspace_tags` que armazena metadados (cor, descrição,
-- soft-delete) das tags utilizadas no workspace. Relação com `lead_tags`
-- é SOFT (match por workspace_id + name, sem FK rígida) — ver ADR-047.
--
-- Conceitos no domínio:
--   - lead_tags.tag_name → texto livre operator-defined; populado por
--     blueprint tag_rules e integrações externas (já existe — migration
--     0044). Permanece texto livre, sem FK.
--   - workspace_tags     → catálogo opcional com metadados de UI. Service
--     layer faz sync via UPSERT idempotente.
--
-- BRs aplicáveis:
--   BR-IDENTITY:    workspace-scoped (RLS dual-mode).
--   BR-AUDIT-001:   created_by + created_at sempre populados.
--   BR-PRIVACY-001: catálogo não contém PII.
--
-- INVs aplicáveis:
--   INV-WORKSPACE-TAG-001: (workspace_id, name) único — DB-enforced.
--   INV-WORKSPACE-TAG-002: created_by segue
--     `user:<uuid> | system:auto-registered | system:blueprint` —
--     validação em service layer (sem CHECK DB, mesmo padrão de
--     lead_tags.set_by / INV-LEAD-TAG-002).
--   INV-WORKSPACE-TAG-003: relação com lead_tags é soft (match por nome).
--
-- Idempotência: CREATE TABLE/INDEX usa IF NOT EXISTS; policy usa
-- DROP IF EXISTS + CREATE — re-run = noop.
-- ============================================================

-- ============================================================
-- 1. Table: workspace_tags
-- ============================================================
CREATE TABLE IF NOT EXISTS workspace_tags (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Multi-tenant anchor — BR-RBAC-002: app.current_workspace_id enforced by RLS.
  -- ON DELETE CASCADE alinhado a lead_tags (catálogo segue o workspace).
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Nome canônico — match com lead_tags.tag_name (texto livre, mesmo charset).
  -- INV-WORKSPACE-TAG-001: unicidade por workspace via uq_* abaixo.
  name         text        NOT NULL,

  -- Cor para UI: hex (#rrggbb) ou token do design system. NULL = sem cor
  -- preferencial; UI aplica fallback neutro.
  color        text,

  -- Descrição livre exibida no catálogo. Não é PII.
  description  text,

  -- Proveniência — INV-WORKSPACE-TAG-002:
  --   'user:<uuid>'              → criação manual no UI de catálogo
  --   'system:auto-registered'   → criada por setLeadTag em runtime
  --   'system:blueprint'         → criada por aplicação de blueprint
  -- Validação em service layer (sem CHECK DB).
  created_by   text        NOT NULL,

  created_at   timestamptz NOT NULL DEFAULT now(),

  -- Soft-delete reversível. NULL = ativa; timestamp = arquivada.
  archived_at  timestamptz,

  -- INV-WORKSPACE-TAG-001: unicidade (workspace_id, name).
  CONSTRAINT uq_workspace_tags_workspace_name
    UNIQUE (workspace_id, name)
);

-- idx_workspace_tags_workspace_active: lookup "tags ativas do workspace"
-- (caso de uso da UI de catálogo + autocomplete de tag picker).
-- Partial index sobre archived_at IS NULL minimiza tamanho.
CREATE INDEX IF NOT EXISTS idx_workspace_tags_workspace_active
  ON workspace_tags (workspace_id)
  WHERE archived_at IS NULL;

-- ============================================================
-- RLS: workspace_tags — dual-mode (GUC + JWT-derived auth_workspace_id).
-- Padrão idêntico ao das demais tabelas workspace-scoped (ver migration
-- 0028 para auth_workspace_id() definition; 0044 para o template de policy).
-- ============================================================
ALTER TABLE workspace_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_tags_workspace_isolation ON workspace_tags;
CREATE POLICY workspace_tags_workspace_isolation ON workspace_tags
  FOR ALL
  USING (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

-- Down (manual rollback):
-- DROP TABLE IF EXISTS workspace_tags;
