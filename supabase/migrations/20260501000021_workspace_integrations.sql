-- Migration: 0021_workspace_integrations
-- Creates workspace_integrations table for storing per-workspace external
-- integration credentials. Sprint 3: Digital Manager Guru token only.
-- Future providers (Meta CAPI, GA4, etc.) add nullable columns here.
--
-- Design: one row per workspace (unique workspace_id) — provider columns are
-- nullable so a workspace without a given integration simply has NULL there.
-- guru_api_token: segredo externo — não logar, não expor em respostas de API.
-- BR-PRIVACY-001 / BR-WEBHOOK-001

CREATE TABLE workspace_integrations (
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id    uuid        NOT NULL,
  guru_api_token  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pk_workspace_integrations PRIMARY KEY (id),

  CONSTRAINT fk_workspace_integrations_workspace
    FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id)
    ON DELETE CASCADE
);

-- INV-WI-001: one-to-one with workspace
CREATE UNIQUE INDEX uq_workspace_integrations_workspace_id
  ON workspace_integrations(workspace_id);

-- chk_workspace_integrations_guru_token_length:
-- when present, Guru API token must be exactly 40 characters.
ALTER TABLE workspace_integrations
  ADD CONSTRAINT chk_workspace_integrations_guru_token_length
  CHECK (guru_api_token IS NULL OR length(guru_api_token) = 40);

-- Down:
-- DROP TABLE workspace_integrations;
