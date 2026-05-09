-- ============================================================
-- 0048_fix_obrigado_workshop_auto_page_view.sql
--
-- Corrige auto_page_view de obrigado-workshop para false.
--
-- Contexto: a migration 0039 definiu canonicamente auto_page_view=false
-- para pages role=thankyou (elas identificam o lead via URL params antes
-- de disparar PageView manualmente). Porém uma edição manual posterior
-- (2026-05-09) sobrescreveu o valor para true, quebrando esse fluxo.
--
-- Política canônica (0039): role=thankyou → auto_page_view: false.
-- Idempotência: UPDATE é noop se já estiver false.
-- ============================================================

BEGIN;

UPDATE pages
   SET event_config = jsonb_set(
         CASE
           WHEN jsonb_typeof(event_config) = 'string'
             THEN (event_config #>> '{}')::jsonb
           ELSE event_config
         END,
         '{auto_page_view}',
         'false'::jsonb
       ),
       updated_at = now()
 WHERE public_id = 'obrigado-workshop';

COMMIT;
