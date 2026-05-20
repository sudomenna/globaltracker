-- ============================================================
-- 0055_recovery_seed_wkshop_cs_jun26.sql
--
-- T-RECOVERY-003 (W3) — Seed inicial do template + campaign de produção
-- para o launch `wkshop-cs-jun26` no workspace Outsiders Digital.
--
-- Configura uma única cadência de recuperação:
--   - Template Meta aprovado na Unnichat (`abandono_7min_wcs_jun26`),
--     ID 2186334448831228, com placeholder de nome do contato e
--     parâmetro de URL para a oferta (`?off=Fn4XA0`).
--   - Campaign disparada por funnel_role='bait_offer' dentro do launch
--     `wkshop-cs-jun26`. Único step (0): delay 7min, janela 07:15–22:30
--     BRT (America/Sao_Paulo), recoverable_statuses com 5 estados de
--     abandono/cancelamento.
--
-- Aplicação:
--   USER APLICA MANUALMENTE VIA PSQL — mesmo padrão das migrations 0053
--   e 0054. Drizzle-kit migrate ESM continua quebrado no monorepo
--   (ver MEMORY.md). Esta migration é puro INSERT — sem DDL, sem RLS.
--
-- BRs / INVs aplicáveis:
--   BR-RBAC-002:               workspace_id em todos os INSERTs.
--   BR-IDENTITY:               launch_id resolvido por public_id +
--                              workspace_id (INV-LAUNCH-001).
--   INV-RECOVERY-TEMPLATE-001: ON CONFLICT (workspace_id, name) DO NOTHING.
--   INV-RECOVERY-CAMPAIGN-001: ON CONFLICT (workspace_id, name) DO NOTHING.
--
-- Idempotência:
--   Re-executar esta migration sem efeitos colaterais — os ON CONFLICT
--   pulam linhas já existentes.
-- ============================================================

DO $$
DECLARE
  -- Workspace dev (Outsiders Digital). Mesma constante do wrangler.toml
  -- (DEV_WORKSPACE_ID). Hardcoded aqui pois seed é workspace-específico.
  v_workspace_id uuid := '74860330-a528-4951-bf49-90f0b5c72521';
  v_launch_id    uuid;
  v_template_id  uuid;
BEGIN
  -- 1. Resolve launch_id por public_id (INV-LAUNCH-001).
  SELECT id INTO v_launch_id
  FROM launches
  WHERE workspace_id = v_workspace_id
    AND public_id = 'wkshop-cs-jun26';

  IF v_launch_id IS NULL THEN
    RAISE EXCEPTION 'launch wkshop-cs-jun26 not found in workspace %', v_workspace_id;
  END IF;

  -- 2. INSERT template (idempotente).
  INSERT INTO recovery_templates (
    workspace_id,
    name,
    unnichat_template_id,
    body_params,
    url_button_params,
    active,
    created_by
  )
  VALUES (
    v_workspace_id,
    'abandono_7min_wcs_jun26',
    '2186334448831228',
    '[{"type":"contactName","fallback":"amigo(a)"}]'::jsonb,
    '[{"type":"text","fallback":"?off=Fn4XA0"}]'::jsonb,
    true,
    'system:bootstrap'
  )
  ON CONFLICT (workspace_id, name) DO NOTHING;

  -- 3. Resolve template_id por (workspace_id, name) — sempre existe após o
  --    INSERT acima (ou já existia, e ON CONFLICT pulou).
  SELECT id INTO v_template_id
  FROM recovery_templates
  WHERE workspace_id = v_workspace_id
    AND name = 'abandono_7min_wcs_jun26';

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'recovery_template abandono_7min_wcs_jun26 not found after upsert';
  END IF;

  -- 4. INSERT campaign (idempotente).
  --    steps[0] = { delay_min: 7, template_id: <uuid do template> }.
  --    Janela 07:15–22:30 BRT — fora dessa faixa o sender adia o tick.
  --    recoverable_statuses cobre 5 estados típicos de abandono em
  --    OnProfit/Hotmart/Guru.
  INSERT INTO recovery_campaigns (
    workspace_id,
    launch_id,
    name,
    trigger_funnel_role,
    steps,
    send_window_start,
    send_window_end,
    send_window_tz,
    recoverable_statuses,
    active
  )
  VALUES (
    v_workspace_id,
    v_launch_id,
    'wcs_jun26_bait_abandono',
    'bait_offer',
    jsonb_build_array(
      jsonb_build_object(
        'delay_min', 7,
        'template_id', v_template_id::text
      )
    ),
    '07:15:00'::time,
    '22:30:00'::time,
    'America/Sao_Paulo',
    '["CART_ABANDONED","WAITING","CANCELED","REJECTED","REFUSED"]'::jsonb,
    true
  )
  ON CONFLICT (workspace_id, name) DO NOTHING;
END
$$;
