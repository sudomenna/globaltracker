-- Migration: 0031_funnel_template_paid_workshop_v2
-- T-FUNIL-030 (Sprint 12) — Realinhamento template `lancamento_pago_workshop_com_main_offer`
-- ao fluxo operacional real do launch `wkshop-cs-jun26` (CS Junho 26).
--
-- Decisões fechadas (ADR-026, ver docs/80-roadmap/12-sprint-12-funil-paid-workshop-realinhamento.md):
--   D1: InitiateCheckout vem do Guru (a investigar pós-sprint) — fora dos stages neste sprint.
--   D2: obrigado-workshop = página de pesquisa + botão WhatsApp ao final.
--   D3: aula-workshop é page nova (role=webinar); MVP binário com botão "Já assisti".
--   D4: tracking aula = binário (`custom:watched_workshop`).
--   D5: click "Quero Comprar" antes da popup vira `custom:click_buy_workshop`.
--   D6: oferta-principal sem popup; `clicked_buy_main` vem de `custom:click_buy_main`.
--
-- BRs aplicáveis:
--   BR-EVENT-001: custom events com prefixo `custom:` exigem matching exato no processor
--                 (raw-events-processor.ts:330) — source_events do blueprint preserva o prefixo.
--   BR-WEBHOOK aplicáveis ao Guru permanecem íntegras (funnel_role no payload já existe).
--
-- INVs aplicáveis:
--   INV-FUNNEL-001: slug único por (workspace_id ou _global) — preservado (mesmo slug, UPDATE).
--   INV-FUNNEL-002: is_system=true exige workspace_id IS NULL — preservado (UPDATE não muda).
--   INV-PAGE-001: (launch_id, public_id) único — UPSERT respeita.
--   INV-PAGE-006: event_config Zod-valid — formas alinhadas com EventConfigSchema.
--
-- Idempotência: todas operações são UPDATE ou INSERT ... ON CONFLICT DO UPDATE / DO NOTHING
-- com guards. Re-run = noop. Sem DROP/DELETE.
--
-- Validação manual do JSONB do blueprint contra FunnelBlueprintSchema (Zod):
--   pnpm tsx -e "import { FunnelBlueprintSchema } from '@gt/shared/schemas/funnel-blueprint'; \
--     import { Pool } from 'pg'; const p = new Pool({ connectionString: process.env.DATABASE_URL }); \
--     const r = await p.query(\"SELECT blueprint FROM funnel_templates WHERE slug='lancamento_pago_workshop_com_main_offer' AND workspace_id IS NULL\"); \
--     console.log(FunnelBlueprintSchema.parse(r.rows[0].blueprint));"
--
-- Depende de: 0029_funnel_templates.sql (template original), 0017_page_tables.sql (pages, page_tokens),
--             0016_audience_tables.sql (audiences), 0002_launch_table.sql (launches).

-- ============================================================
-- (1) UPDATE template canônico — forma v2 (8 stages, 5 pages, 6 audiences)
-- ============================================================
UPDATE funnel_templates
   SET blueprint = $json${
    "type": "lancamento_pago",
    "has_main_offer": true,
    "has_workshop": true,
    "stages": [
      {"slug": "lead_workshop",        "label": "Lead identificado (workshop)",       "is_recurring": false, "source_events": ["Lead"]},
      {"slug": "clicked_buy_workshop", "label": "Clicou comprar workshop",            "is_recurring": true,  "source_events": ["custom:click_buy_workshop"]},
      {"slug": "purchased_workshop",   "label": "Comprou workshop",                   "is_recurring": false, "source_events": ["Purchase"], "source_event_filters": {"funnel_role": "workshop"}},
      {"slug": "survey_responded",     "label": "Respondeu pesquisa",                 "is_recurring": false, "source_events": ["custom:survey_responded"]},
      {"slug": "wpp_joined",           "label": "Entrou no WhatsApp",                 "is_recurring": false, "source_events": ["Contact"]},
      {"slug": "watched_workshop",     "label": "Assistiu workshop",                  "is_recurring": false, "source_events": ["custom:watched_workshop"]},
      {"slug": "clicked_buy_main",     "label": "Clicou comprar oferta principal",    "is_recurring": true,  "source_events": ["custom:click_buy_main"]},
      {"slug": "purchased_main",       "label": "Comprou oferta principal",           "is_recurring": false, "source_events": ["Purchase"], "source_event_filters": {"funnel_role": "main_offer"}}
    ],
    "pages": [
      {"role": "sales",    "suggested_public_id": "workshop",           "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView","Lead"],                  "custom": ["click_buy_workshop"]}},
      {"role": "thankyou", "suggested_public_id": "obrigado-workshop",  "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView","Purchase","Contact"],    "custom": ["survey_responded"]}},
      {"role": "webinar",  "suggested_public_id": "aula-workshop",      "suggested_funnel_role": "workshop",   "event_config": {"canonical": ["PageView"],                          "custom": ["watched_workshop"]}},
      {"role": "sales",    "suggested_public_id": "oferta-principal",   "suggested_funnel_role": "main_offer", "event_config": {"canonical": ["PageView","ViewContent"],            "custom": ["click_buy_main"]}},
      {"role": "thankyou", "suggested_public_id": "obrigado-principal", "suggested_funnel_role": "main_offer", "event_config": {"canonical": ["PageView","Purchase"],               "custom": []}}
    ],
    "audiences": [
      {"slug": "compradores_workshop_aquecimento",     "name": "Compradores workshop — aquecimento", "platform": "meta", "query_template": {"stage_eq":  "purchased_workshop", "stage_not": "purchased_main"}},
      {"slug": "respondeu_pesquisa_sem_comprar_main",  "name": "Respondeu pesquisa, sem comprar main","platform": "meta", "query_template": {"stage_eq":  "survey_responded",   "stage_not": "purchased_main"}},
      {"slug": "engajados_workshop",                   "name": "Engajados no workshop",               "platform": "meta", "query_template": {"stage_gte": "watched_workshop"}},
      {"slug": "abandono_main_offer",                  "name": "Abandono oferta principal",           "platform": "meta", "query_template": {"stage_eq":  "clicked_buy_main",   "stage_not": "purchased_main"}},
      {"slug": "compradores_main",                     "name": "Compradores oferta principal",        "platform": "meta", "query_template": {"stage_eq":  "purchased_main"}},
      {"slug": "nao_compradores_workshop_engajados",   "name": "Engajados workshop, sem compra",      "platform": "meta", "query_template": {"stage_gte": "watched_workshop",   "stage_not": "purchased_main"}}
    ]
  }$json$::jsonb,
       updated_at = now()
 WHERE slug = 'lancamento_pago_workshop_com_main_offer'
   AND workspace_id IS NULL;

-- ============================================================
-- (2) UPDATE launch snapshot — wkshop-cs-jun26
-- Snapshot do blueprint atualizado é projetado dentro do launch real em produção.
-- ============================================================
UPDATE launches
   SET funnel_blueprint = (
         SELECT blueprint
           FROM funnel_templates
          WHERE slug = 'lancamento_pago_workshop_com_main_offer'
            AND workspace_id IS NULL
       ),
       updated_at = now()
 WHERE public_id   = 'wkshop-cs-jun26'
   AND workspace_id = '74860330-a528-4951-bf49-90f0b5c72521';

-- ============================================================
-- (3) UPSERT pages — 5 pages do launch wkshop-cs-jun26
-- INV-PAGE-001: UNIQUE (launch_id, public_id) — uq_pages_launch_public_id.
-- Estratégia: UPSERT só atualiza role + event_config + updated_at. NÃO mexe em
-- url/status/allowed_domains/integration_mode/variant das pages existentes.
-- Pages novas (aula-workshop, oferta-principal, obrigado-principal) entram com
-- status='draft', url=NULL e integration_mode default ('b_snippet').
-- ============================================================
DO $upsert_pages$
DECLARE
  v_workspace_id uuid := '74860330-a528-4951-bf49-90f0b5c72521';
  v_launch_id    uuid;
BEGIN
  SELECT id INTO v_launch_id
    FROM launches
   WHERE public_id   = 'wkshop-cs-jun26'
     AND workspace_id = v_workspace_id;

  IF v_launch_id IS NULL THEN
    RAISE EXCEPTION 'Launch wkshop-cs-jun26 not found in workspace %', v_workspace_id;
  END IF;

  -- workshop (existente) — atualiza event_config para incluir Lead canonical + click_buy_workshop custom
  INSERT INTO pages (workspace_id, launch_id, public_id, role, event_config)
  VALUES (
    v_workspace_id,
    v_launch_id,
    'workshop',
    'sales',
    '{"canonical":["PageView","Lead"],"custom":["click_buy_workshop"],"auto_page_view":true,"pixel_policy":"server_only"}'::jsonb
  )
  ON CONFLICT (launch_id, public_id) DO UPDATE
    SET role         = EXCLUDED.role,
        event_config = pages.event_config
                       || '{"canonical":["PageView","Lead"],"custom":["click_buy_workshop"]}'::jsonb,
        updated_at   = now();

  -- obrigado-workshop (existente) — adiciona Contact + custom survey_responded
  INSERT INTO pages (workspace_id, launch_id, public_id, role, event_config)
  VALUES (
    v_workspace_id,
    v_launch_id,
    'obrigado-workshop',
    'thankyou',
    '{"canonical":["PageView","Purchase","Contact"],"custom":["survey_responded"],"auto_page_view":true,"pixel_policy":"server_only"}'::jsonb
  )
  ON CONFLICT (launch_id, public_id) DO UPDATE
    SET role         = EXCLUDED.role,
        event_config = pages.event_config
                       || '{"canonical":["PageView","Purchase","Contact"],"custom":["survey_responded"]}'::jsonb,
        updated_at   = now();

  -- aula-workshop (NOVA) — role=webinar, status=draft, url=NULL
  INSERT INTO pages (workspace_id, launch_id, public_id, role, event_config, status)
  VALUES (
    v_workspace_id,
    v_launch_id,
    'aula-workshop',
    'webinar',
    '{"canonical":["PageView"],"custom":["watched_workshop"],"auto_page_view":true,"pixel_policy":"server_only"}'::jsonb,
    'draft'
  )
  ON CONFLICT (launch_id, public_id) DO UPDATE
    SET role         = EXCLUDED.role,
        event_config = pages.event_config
                       || '{"canonical":["PageView"],"custom":["watched_workshop"]}'::jsonb,
        updated_at   = now();

  -- oferta-principal (NOVA) — role=sales, status=draft, url=NULL
  INSERT INTO pages (workspace_id, launch_id, public_id, role, event_config, status)
  VALUES (
    v_workspace_id,
    v_launch_id,
    'oferta-principal',
    'sales',
    '{"canonical":["PageView","ViewContent"],"custom":["click_buy_main"],"auto_page_view":true,"pixel_policy":"server_only"}'::jsonb,
    'draft'
  )
  ON CONFLICT (launch_id, public_id) DO UPDATE
    SET role         = EXCLUDED.role,
        event_config = pages.event_config
                       || '{"canonical":["PageView","ViewContent"],"custom":["click_buy_main"]}'::jsonb,
        updated_at   = now();

  -- obrigado-principal (NOVA) — role=thankyou, status=draft, url=NULL
  INSERT INTO pages (workspace_id, launch_id, public_id, role, event_config, status)
  VALUES (
    v_workspace_id,
    v_launch_id,
    'obrigado-principal',
    'thankyou',
    '{"canonical":["PageView","Purchase"],"custom":[],"auto_page_view":true,"pixel_policy":"server_only"}'::jsonb,
    'draft'
  )
  ON CONFLICT (launch_id, public_id) DO UPDATE
    SET role         = EXCLUDED.role,
        event_config = pages.event_config
                       || '{"canonical":["PageView","Purchase"],"custom":[]}'::jsonb,
        updated_at   = now();
END
$upsert_pages$;

-- ============================================================
-- (4) page_tokens — gerar token novo para pages que não têm token ativo
-- ADR-023: token_hash = SHA-256 hex do clear token. INV-PAGE-003: token_hash globally unique.
-- Estratégia idempotente: WHERE NOT EXISTS guard por page_id com status IN ('active','rotating').
-- Tokens existentes (workshop, obrigado-workshop) NÃO são tocados — preservam valores em uso
-- nos snippets Framer já deployados (ver MEMORY.md §7).
--
-- Clear token é gerado em runtime via gen_random_bytes(32) (pgcrypto, instalada em 0000_initial.sql)
-- e emitido via RAISE NOTICE para captura pelo operador em log do psql/Supabase. O DB
-- armazena apenas o SHA-256 hex.
--
-- IMPORTANTE: ao re-rodar a migration, este bloco é noop (active token já existe), portanto
-- o RAISE NOTICE só dispara na primeira execução de cada page nova. Operador deve capturar
-- o output do psql na primeira aplicação. Se perder, gerar novo token via rotação manual
-- (out-of-scope desta migration).
-- ============================================================
DO $gen_tokens$
DECLARE
  v_workspace_id uuid := '74860330-a528-4951-bf49-90f0b5c72521';
  v_launch_id    uuid;
  v_page_record  record;
  v_clear_token  text;
  v_token_hash   text;
BEGIN
  SELECT id INTO v_launch_id
    FROM launches
   WHERE public_id   = 'wkshop-cs-jun26'
     AND workspace_id = v_workspace_id;

  IF v_launch_id IS NULL THEN
    RAISE EXCEPTION 'Launch wkshop-cs-jun26 not found in workspace %', v_workspace_id;
  END IF;

  FOR v_page_record IN
    SELECT id, public_id
      FROM pages
     WHERE launch_id    = v_launch_id
       AND workspace_id = v_workspace_id
       AND public_id IN ('workshop', 'obrigado-workshop', 'aula-workshop',
                         'oferta-principal', 'obrigado-principal')
  LOOP
    -- Skip if any non-revoked token already exists for this page (idempotência)
    IF EXISTS (
      SELECT 1
        FROM page_tokens
       WHERE page_id = v_page_record.id
         AND status IN ('active', 'rotating')
    ) THEN
      CONTINUE;
    END IF;

    -- Gerar clear token = 32 random bytes em hex (64 chars)
    -- Supabase instala pgcrypto no schema `extensions` (não `public`); prefixar para search_path.
    v_clear_token := encode(extensions.gen_random_bytes(32), 'hex');
    -- token_hash = SHA-256 hex do clear token (64 chars) — chk_page_tokens_token_hash_length
    v_token_hash  := encode(extensions.digest(v_clear_token, 'sha256'), 'hex');

    INSERT INTO page_tokens (workspace_id, page_id, token_hash, label, status)
    VALUES (
      v_workspace_id,
      v_page_record.id,
      v_token_hash,
      'sprint-12 — initial',
      'active'
    );

    -- Emitir clear token para captura pelo operador (out-of-band)
    RAISE NOTICE '[T-FUNIL-030] page_token gerado para page public_id=% (page_id=%): clear_token=%',
                 v_page_record.public_id, v_page_record.id, v_clear_token;
  END LOOP;
END
$gen_tokens$;

-- ============================================================
-- (5) UPSERT audiences — 6 audiences scaffoldadas pelo template v2.
-- Audiences são workspace-scoped (não há launch_id na tabela). UNIQUE = (workspace_id, public_id).
-- query_definition embute launch_public_id='wkshop-cs-jun26' para escopar a query ao launch.
--
-- destination_strategy: meta_custom_audience (platform=meta, default eligível).
-- consent_policy: vazio (default) — preenchido pelo service layer no primeiro snapshot.
--
-- Audience legacy `compradores_apenas_workshop` (criada por 0029) é arquivada
-- (status='archived') — NÃO apaga histórico. Se não existir, noop. Decisão: manter row
-- para audit trail; tabela audiences não tem coluna `archived_at`, soft-delete é via status.
-- ============================================================
DO $upsert_audiences$
DECLARE
  v_workspace_id uuid := '74860330-a528-4951-bf49-90f0b5c72521';
  v_launch_id    uuid;
BEGIN
  SELECT id INTO v_launch_id
    FROM launches
   WHERE public_id   = 'wkshop-cs-jun26'
     AND workspace_id = v_workspace_id;

  IF v_launch_id IS NULL THEN
    RAISE EXCEPTION 'Launch wkshop-cs-jun26 not found in workspace %', v_workspace_id;
  END IF;

  -- compradores_workshop_aquecimento
  INSERT INTO audiences (workspace_id, public_id, name, platform, destination_strategy, query_definition, status)
  VALUES (
    v_workspace_id,
    'compradores_workshop_aquecimento',
    'Compradores workshop — aquecimento',
    'meta',
    'meta_custom_audience',
    jsonb_build_object(
      'type', 'builder',
      'launch_public_id', 'wkshop-cs-jun26',
      'launch_id', v_launch_id::text,
      'all', jsonb_build_array(
        jsonb_build_object('stage_eq',  'purchased_workshop'),
        jsonb_build_object('stage_not', 'purchased_main')
      )
    ),
    'draft'
  )
  ON CONFLICT (workspace_id, public_id) DO UPDATE
    SET name             = EXCLUDED.name,
        platform         = EXCLUDED.platform,
        query_definition = EXCLUDED.query_definition,
        updated_at       = now();

  -- respondeu_pesquisa_sem_comprar_main
  INSERT INTO audiences (workspace_id, public_id, name, platform, destination_strategy, query_definition, status)
  VALUES (
    v_workspace_id,
    'respondeu_pesquisa_sem_comprar_main',
    'Respondeu pesquisa, sem comprar main',
    'meta',
    'meta_custom_audience',
    jsonb_build_object(
      'type', 'builder',
      'launch_public_id', 'wkshop-cs-jun26',
      'launch_id', v_launch_id::text,
      'all', jsonb_build_array(
        jsonb_build_object('stage_eq',  'survey_responded'),
        jsonb_build_object('stage_not', 'purchased_main')
      )
    ),
    'draft'
  )
  ON CONFLICT (workspace_id, public_id) DO UPDATE
    SET name             = EXCLUDED.name,
        platform         = EXCLUDED.platform,
        query_definition = EXCLUDED.query_definition,
        updated_at       = now();

  -- engajados_workshop (substitui versão antiga que usava watched_class_1)
  INSERT INTO audiences (workspace_id, public_id, name, platform, destination_strategy, query_definition, status)
  VALUES (
    v_workspace_id,
    'engajados_workshop',
    'Engajados no workshop',
    'meta',
    'meta_custom_audience',
    jsonb_build_object(
      'type', 'builder',
      'launch_public_id', 'wkshop-cs-jun26',
      'launch_id', v_launch_id::text,
      'all', jsonb_build_array(
        jsonb_build_object('stage_gte', 'watched_workshop')
      )
    ),
    'draft'
  )
  ON CONFLICT (workspace_id, public_id) DO UPDATE
    SET name             = EXCLUDED.name,
        platform         = EXCLUDED.platform,
        query_definition = EXCLUDED.query_definition,
        updated_at       = now();

  -- abandono_main_offer
  INSERT INTO audiences (workspace_id, public_id, name, platform, destination_strategy, query_definition, status)
  VALUES (
    v_workspace_id,
    'abandono_main_offer',
    'Abandono oferta principal',
    'meta',
    'meta_custom_audience',
    jsonb_build_object(
      'type', 'builder',
      'launch_public_id', 'wkshop-cs-jun26',
      'launch_id', v_launch_id::text,
      'all', jsonb_build_array(
        jsonb_build_object('stage_eq',  'clicked_buy_main'),
        jsonb_build_object('stage_not', 'purchased_main')
      )
    ),
    'draft'
  )
  ON CONFLICT (workspace_id, public_id) DO UPDATE
    SET name             = EXCLUDED.name,
        platform         = EXCLUDED.platform,
        query_definition = EXCLUDED.query_definition,
        updated_at       = now();

  -- compradores_main
  INSERT INTO audiences (workspace_id, public_id, name, platform, destination_strategy, query_definition, status)
  VALUES (
    v_workspace_id,
    'compradores_main',
    'Compradores oferta principal',
    'meta',
    'meta_custom_audience',
    jsonb_build_object(
      'type', 'builder',
      'launch_public_id', 'wkshop-cs-jun26',
      'launch_id', v_launch_id::text,
      'all', jsonb_build_array(
        jsonb_build_object('stage_eq', 'purchased_main')
      )
    ),
    'draft'
  )
  ON CONFLICT (workspace_id, public_id) DO UPDATE
    SET name             = EXCLUDED.name,
        platform         = EXCLUDED.platform,
        query_definition = EXCLUDED.query_definition,
        updated_at       = now();

  -- nao_compradores_workshop_engajados
  INSERT INTO audiences (workspace_id, public_id, name, platform, destination_strategy, query_definition, status)
  VALUES (
    v_workspace_id,
    'nao_compradores_workshop_engajados',
    'Engajados workshop, sem compra',
    'meta',
    'meta_custom_audience',
    jsonb_build_object(
      'type', 'builder',
      'launch_public_id', 'wkshop-cs-jun26',
      'launch_id', v_launch_id::text,
      'all', jsonb_build_array(
        jsonb_build_object('stage_gte', 'watched_workshop'),
        jsonb_build_object('stage_not', 'purchased_main')
      )
    ),
    'draft'
  )
  ON CONFLICT (workspace_id, public_id) DO UPDATE
    SET name             = EXCLUDED.name,
        platform         = EXCLUDED.platform,
        query_definition = EXCLUDED.query_definition,
        updated_at       = now();

  -- Archive legacy audience compradores_apenas_workshop (duplicata de
  -- compradores_workshop_aquecimento). Soft-delete via status='archived'.
  -- Se não existir nesse workspace, UPDATE é noop. Histórico (snapshots/sync_jobs)
  -- preservado por FK ON DELETE RESTRICT.
  UPDATE audiences
     SET status     = 'archived',
         updated_at = now()
   WHERE workspace_id = v_workspace_id
     AND public_id    = 'compradores_apenas_workshop'
     AND status      <> 'archived';
END
$upsert_audiences$;

-- ============================================================
-- Down (manual rollback) — não recomendado em produção; histórico de leads
-- e audience snapshots dependem do shape v2 a partir desta data.
-- Para reverter:
--   1. Restaurar blueprint anterior em funnel_templates (do 0029_funnel_templates.sql).
--   2. Anular launches.funnel_blueprint do wkshop-cs-jun26 ou re-snapshot do template antigo.
--   3. Pages aula-workshop / oferta-principal / obrigado-principal: marcar status='archived'
--      (NÃO DELETE — token + events history).
--   4. Audiences novas: status='archived'.
-- ============================================================
