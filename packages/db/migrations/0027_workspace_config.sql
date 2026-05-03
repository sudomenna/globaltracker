-- Migration 0027: Add config JSONB column to workspaces
-- Stores workspace-level integration credentials (Meta CAPI token, GA4 api_secret)
-- populated by the onboarding wizard when step='complete'.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}';
