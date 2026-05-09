-- 0045_products_onprofit_provider.sql
-- Adds 'onprofit' to chk_products_external_provider so the OnProfit webhook
-- adapter can auto-create products via upsertProduct(externalProvider='onprofit').
--
-- Without this, the OnProfit raw-events processor logs a non-fatal warning
-- (`onprofit_product_lifecycle_promotion_failed`) on every Purchase and
-- skips lifecycle promotion + product catalog row creation. The Meta CAPI /
-- GA4 / Google Ads dispatch still fires correctly — only the products row
-- + leads.lifecycle_status promotion are blocked.

ALTER TABLE products DROP CONSTRAINT IF EXISTS chk_products_external_provider;

ALTER TABLE products ADD CONSTRAINT chk_products_external_provider
  CHECK (external_provider IN ('guru', 'hotmart', 'kiwify', 'stripe', 'manual', 'onprofit'));
