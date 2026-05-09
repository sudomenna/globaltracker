-- ============================================================
-- 0049_supersede_orphan_email_phone_aliases.sql
--
-- Backfill 1-shot: marca como `superseded` aliases ativos cujo
-- identifier_hash não bate com o canonical denormalizado em
-- `leads.email_hash` / `leads.phone_hash`.
--
-- Contexto (descoberto 2026-05-09 via lead `75b3ed42`):
--   Pedro digitou email com typo `.con`, criou alias email_hash
--   `dcb534c0...`. Submeteu o form de novo com email correto `.com`,
--   alias canonical virou `32f13156...`, MAS o alias `.con` continuou
--   `status='active'`. Risco: outro visitante futuro que digite o
--   mesmo typo `.con` será mergeado nesse lead (cross-contamination).
--
--   Forward-fix em `apps/edge/src/lib/lead-resolver.ts` resolve para
--   novos submits; esta migration limpa os 6 órfãos pré-existentes
--   (4 leads afetados na auditoria de 2026-05-09).
--
-- Critério canônico:
--   Se `lead_aliases.identifier_type IN ('email_hash','phone_hash')`
--   está ativo MAS o `identifier_hash` difere do `leads.email_hash` /
--   `leads.phone_hash` correspondente, é histórico (substituído).
--   Marcar como `superseded`.
--
-- Idempotência: re-run = noop (UPDATE de superseded → superseded).
--
-- Não afeta: aliases `external_id_hash` (sem coluna denormalizada
-- equivalente — vem só de webhook providers), aliases já merged/revoked.
-- ============================================================

BEGIN;

UPDATE lead_aliases la
   SET status = 'superseded'
  FROM leads l
 WHERE la.lead_id = l.id
   AND la.status = 'active'
   AND la.identifier_type IN ('email_hash', 'phone_hash')
   AND (
        (la.identifier_type = 'email_hash'
           AND l.email_hash IS NOT NULL
           AND l.email_hash <> la.identifier_hash)
     OR (la.identifier_type = 'phone_hash'
           AND l.phone_hash IS NOT NULL
           AND l.phone_hash <> la.identifier_hash)
   );

COMMIT;
