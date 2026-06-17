-- 0058_product_category_extensao.sql
--
-- Adds 'extensao' (Extensão) as a valid products.category value.
--
-- "Extensão" cobre curso de extensão / acesso estendido (ex.: OB Acesso Vitalício).
-- Lifecycle: categoria → 'aluno' (ver apps/edge/src/lib/lifecycle-rules.ts
-- CATEGORY_TO_LIFECYCLE), consistente com os demais cursos.
--
-- Aditivo e não-destrutivo: só amplia o CHECK chk_products_category.

BEGIN;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS chk_products_category;

ALTER TABLE products
  ADD CONSTRAINT chk_products_category CHECK (
    category IS NULL OR category IN (
      'ebook', 'workshop_online', 'webinar',
      'curso_online', 'curso_presencial', 'pos_graduacao', 'treinamento_online', 'evento_fisico',
      'mentoria_individual', 'mentoria_grupo', 'acompanhamento_individual', 'extensao'
    )
  );

COMMIT;
