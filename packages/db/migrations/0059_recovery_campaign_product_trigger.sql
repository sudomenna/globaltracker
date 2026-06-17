-- 0059_recovery_campaign_product_trigger.sql
--
-- Gatilho HÍBRIDO de recovery: campanha pode mirar um PRODUTO específico
-- (trigger_product_id) além do funnel_role.
--
-- - trigger_product_id (uuid NULL → FK products, ON DELETE CASCADE): quando
--   setado, a campanha recupera abandonos daquele produto e tem PRECEDÊNCIA
--   sobre campanhas por role no mesmo launch (lógica no job-creator).
-- - trigger_funnel_role passa a NULLABLE (campanha por produto não precisa de role).
-- - CHECK: pelo menos um dos dois gatilhos setado.
--
-- Aditivo (coluna nova nullable + relaxa NOT NULL + CHECK). Não-destrutivo.

BEGIN;

ALTER TABLE recovery_campaigns
  ADD COLUMN trigger_product_id uuid REFERENCES products(id) ON DELETE CASCADE;

ALTER TABLE recovery_campaigns
  ALTER COLUMN trigger_funnel_role DROP NOT NULL;

ALTER TABLE recovery_campaigns
  ADD CONSTRAINT chk_recovery_campaigns_trigger CHECK (
    trigger_funnel_role IS NOT NULL OR trigger_product_id IS NOT NULL
  );

COMMIT;
