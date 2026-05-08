-- Migration 0042: products table + leads.lifecycle_status column
-- Sprint: lead categorization by product purchased

-- ============================================================================
-- 1. CREATE TABLE products
-- ============================================================================

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NULL,  -- NULL = não categorizado ainda
  external_provider text NOT NULL,  -- 'guru' | 'hotmart' | 'kiwify' | 'stripe' | 'manual'
  external_product_id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_products_category CHECK (
    category IS NULL OR category IN (
      'ebook', 'workshop_online', 'webinar',
      'curso_online', 'curso_presencial', 'pos_graduacao', 'treinamento_online', 'evento_fisico',
      'mentoria_individual', 'mentoria_grupo', 'acompanhamento_individual'
    )
  ),
  CONSTRAINT chk_products_status CHECK (status IN ('active', 'archived')),
  CONSTRAINT chk_products_external_provider CHECK (
    external_provider IN ('guru', 'hotmart', 'kiwify', 'stripe', 'manual')
  ),
  CONSTRAINT chk_products_name_length CHECK (length(name) BETWEEN 1 AND 256),
  CONSTRAINT chk_products_external_product_id_length CHECK (length(external_product_id) BETWEEN 1 AND 256),
  CONSTRAINT uq_products_workspace_provider_external_id
    UNIQUE (workspace_id, external_provider, external_product_id)
);

CREATE INDEX idx_products_workspace_status ON products(workspace_id, status);
CREATE INDEX idx_products_workspace_category ON products(workspace_id, category) WHERE category IS NOT NULL;

-- RLS pattern segue 0028 (auth_workspace_id() function)
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY products_workspace_isolation ON products
  USING (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

COMMENT ON TABLE products IS
  'Catálogo de produtos por workspace. Auto-criado quando webhook traz product_id desconhecido (category=NULL). Operador atribui categoria via UI /products que dispara backfill de leads.lifecycle_status.';
COMMENT ON COLUMN products.category IS
  '11 categorias canônicas hardcoded (ebook/workshop_online/webinar→cliente; curso_*/pos_*/treinamento_*/evento_*→aluno; mentoria_*/acompanhamento_*→mentorado). NULL = pending categorização.';
COMMENT ON COLUMN products.external_provider IS
  'Provider de origem: guru|hotmart|kiwify|stripe|manual.';

-- ============================================================================
-- 2. ALTER leads — add lifecycle_status
-- ============================================================================

ALTER TABLE leads
  ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'contato';

ALTER TABLE leads
  ADD CONSTRAINT chk_leads_lifecycle_status CHECK (
    lifecycle_status IN ('contato', 'lead', 'cliente', 'aluno', 'mentorado')
  );

CREATE INDEX idx_leads_workspace_lifecycle ON leads(workspace_id, lifecycle_status)
  WHERE status = 'active';

COMMENT ON COLUMN leads.lifecycle_status IS
  'Categoria de relacionamento monotônica derivada de compras + funil. Hierarquia: mentorado(4) > aluno(3) > cliente(2) > lead(1) > contato(0). Atualizada por lifecycle-promoter.ts.';
