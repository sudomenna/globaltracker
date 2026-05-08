-- Migration 0043: launch_products association table
-- Sprint: lead categorization phase 2 — explicit product↔launch with role enum.
--
-- Substitui workspaces.config.integrations.guru.product_launch_map (legacy)
-- por relação tipada launch_products(launch_id, product_id, launch_role).
-- launch_role enum estrito: main_offer | main_order_bump | bait_offer | bait_order_bump.
--
-- Webhook resolver (guru-launch-resolver.ts) passará a usar essa tabela como
-- fonte primária. Map legacy fica como fallback até ser purgada.

CREATE TABLE launch_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  launch_id uuid NOT NULL REFERENCES launches(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  launch_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_launch_products_launch_role CHECK (
    launch_role IN ('main_offer', 'main_order_bump', 'bait_offer', 'bait_order_bump')
  ),
  CONSTRAINT uq_launch_products_launch_product UNIQUE (launch_id, product_id)
);

CREATE INDEX idx_launch_products_workspace ON launch_products(workspace_id);
CREATE INDEX idx_launch_products_launch ON launch_products(launch_id);
CREATE INDEX idx_launch_products_product ON launch_products(product_id);

ALTER TABLE launch_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY launch_products_workspace_isolation ON launch_products
  USING (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  )
  WITH CHECK (
    workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    OR workspace_id = public.auth_workspace_id()
  );

COMMENT ON TABLE launch_products IS
  'Associação product↔launch com papel tipado. Substitui workspaces.config.integrations.guru.product_launch_map (legacy mantido como fallback).';
COMMENT ON COLUMN launch_products.launch_role IS
  'Enum: main_offer | main_order_bump | bait_offer | bait_order_bump.';
