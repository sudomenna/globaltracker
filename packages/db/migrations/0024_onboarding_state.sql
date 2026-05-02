-- T-6-001: Sprint 6 — onboarding state for control plane wizard
-- Structure enforced at app layer via Zod (OnboardingStateSchema in packages/shared)
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS onboarding_state JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN workspaces.onboarding_state IS
  'Wizard progress for Sprint 6 onboarding. Structure: {started_at, completed_at, skipped_at, step_meta, step_ga4, step_launch, step_page, step_install}';

-- Down:
-- ALTER TABLE workspaces DROP COLUMN IF EXISTS onboarding_state;
