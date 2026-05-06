-- T-OPB-001: external PII hashes for Meta CAPI / Google Enhanced Conversions
-- sha256(normalized_value) puro, sem workspace scope
-- Manter email_hash/phone_hash existentes (uso interno lead-resolver)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS email_hash_external text,
  ADD COLUMN IF NOT EXISTS phone_hash_external text,
  ADD COLUMN IF NOT EXISTS fn_hash text,
  ADD COLUMN IF NOT EXISTS ln_hash text;
