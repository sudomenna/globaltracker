-- ============================================================
-- 0032_reorder_stages_paid_workshop_v2.sql
-- Reorder cronológico do template `lancamento_pago_workshop_com_main_offer`:
--   clicked_buy_workshop antes de lead_workshop (clica botão antes de preencher form).
--
-- Idempotente: re-execução não tem efeito (SET é igualitário ao final).
-- Não destrói dados — apenas swap de posições no array `blueprint.stages`.
-- BR-EVENT-001: matching por event_name é independente de ordem; alteração afeta
-- apenas semântica de `stage_gte` (T-FUNIL-040). Audiences atuais não usam stage_gte
-- com lead_workshop/clicked_buy_workshop, então sem regressão funcional.
-- ============================================================

DO $reorder$
DECLARE
  v_slug_0 text;
  v_slug_1 text;
BEGIN
  SELECT blueprint->'stages'->0->>'slug',
         blueprint->'stages'->1->>'slug'
    INTO v_slug_0, v_slug_1
    FROM funnel_templates
   WHERE slug = 'lancamento_pago_workshop_com_main_offer'
     AND workspace_id IS NULL;

  -- Já está na ordem alvo? noop
  IF v_slug_0 = 'clicked_buy_workshop' AND v_slug_1 = 'lead_workshop' THEN
    RAISE NOTICE '[0032] Stages já na ordem alvo — noop.';
    RETURN;
  END IF;

  -- Pre-reorder esperado: lead_workshop primeiro
  IF v_slug_0 <> 'lead_workshop' OR v_slug_1 <> 'clicked_buy_workshop' THEN
    RAISE EXCEPTION '[0032] Estado inesperado: stages[0]=% stages[1]=%', v_slug_0, v_slug_1;
  END IF;

  UPDATE funnel_templates
     SET blueprint = jsonb_set(
           blueprint,
           '{stages}',
           jsonb_build_array(
             blueprint->'stages'->1,
             blueprint->'stages'->0,
             blueprint->'stages'->2,
             blueprint->'stages'->3,
             blueprint->'stages'->4,
             blueprint->'stages'->5,
             blueprint->'stages'->6,
             blueprint->'stages'->7
           )
         ),
         updated_at = now()
   WHERE slug = 'lancamento_pago_workshop_com_main_offer'
     AND workspace_id IS NULL;

  -- Espelhar nos snapshots existentes deste template
  UPDATE launches l
     SET funnel_blueprint = jsonb_set(
           funnel_blueprint,
           '{stages}',
           jsonb_build_array(
             funnel_blueprint->'stages'->1,
             funnel_blueprint->'stages'->0,
             funnel_blueprint->'stages'->2,
             funnel_blueprint->'stages'->3,
             funnel_blueprint->'stages'->4,
             funnel_blueprint->'stages'->5,
             funnel_blueprint->'stages'->6,
             funnel_blueprint->'stages'->7
           )
         ),
         updated_at = now()
   WHERE funnel_template_id = (
           SELECT id FROM funnel_templates
            WHERE slug = 'lancamento_pago_workshop_com_main_offer'
              AND workspace_id IS NULL
         )
     AND funnel_blueprint->'stages'->0->>'slug' = 'lead_workshop'
     AND funnel_blueprint->'stages'->1->>'slug' = 'clicked_buy_workshop';
END
$reorder$;
