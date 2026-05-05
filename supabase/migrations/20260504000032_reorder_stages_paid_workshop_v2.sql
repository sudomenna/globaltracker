-- ============================================================
-- 20260504000032_reorder_stages_paid_workshop_v2.sql
-- Mirror de packages/db/migrations/0032_reorder_stages_paid_workshop_v2.sql
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

  IF v_slug_0 = 'clicked_buy_workshop' AND v_slug_1 = 'lead_workshop' THEN
    RAISE NOTICE '[0032] Stages já na ordem alvo — noop.';
    RETURN;
  END IF;

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

  UPDATE launches
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
