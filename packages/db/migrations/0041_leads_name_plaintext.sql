-- Migration 0041: leads.name plaintext + index
--
-- ADR-034: name deixa de ser PII protegido. Adiciona coluna text plain para
-- search ILIKE indexed e exibição direta sem decrypt overhead.
--
-- name_enc permanece (legacy) durante transição — backfill posterior popula
-- leads.name a partir de name_enc. Writers param de gravar name_enc após
-- deploy desta migration.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS name text;

-- Index for ILIKE substring search on lower(name).
-- text_pattern_ops permite ILIKE com lower() prefix; para %x% em qualquer posição,
-- pg_trgm seria mais eficiente, mas exige extension. Para o tamanho atual do
-- dataset (centenas de leads), btree em lower(name) text_pattern_ops é suficiente.
CREATE INDEX IF NOT EXISTS idx_leads_name_lower ON leads (lower(name) text_pattern_ops)
  WHERE name IS NOT NULL;

COMMENT ON COLUMN leads.name IS
  'Plaintext name for ILIKE search (ADR-034). name_enc deprecated — backfill via decrypt.';
