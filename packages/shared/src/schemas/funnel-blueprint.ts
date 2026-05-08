import { z } from 'zod';

// T-FUNIL-010: Canonical Zod schema for funnel blueprint stored in funnel_templates.blueprint
// and snapshotted in launches.funnel_blueprint.
//
// Shape reflects Sprint 10 roadmap — FunnelBlueprintSchema is the source of truth
// for validating jsonb before any DB write.
//
// T-LEADS-VIEW-001: extension — leads_view + tag_rules (optional para retrocompat
// com blueprints que ainda não foram migrados). Migration 0044 popula esses campos
// no template `lancamento_pago_workshop_com_main_offer` e nos launches que o usam.

// ============================================================
// Stage: represents one funnel stage (e.g. captura, webinar, checkout)
// ============================================================
const FunnelStageSchema = z.object({
  // Unique identifier within the blueprint (e.g. 'captura', 'webinar', 'checkout')
  slug: z.string().min(1),

  // Display label (e.g. 'Captura de Leads', 'Webinar Ao Vivo')
  label: z.string().min(1),

  // Whether this stage recurs over time (e.g. ongoing evergreen stage)
  is_recurring: z.boolean(),

  // Canonical event names that qualify a lead as having entered this stage
  // At least one source event is required per stage
  source_events: z.array(z.string().min(1)).min(1),

  // Optional key-value filters applied to source event payload (e.g. { product_id: 'abc' })
  source_event_filters: z.record(z.string()).optional(),
});

// ============================================================
// Page: represents a landing page role within the funnel
// ============================================================
const FunnelPageSchema = z.object({
  // Semantic role of this page in the funnel
  role: z.enum(['capture', 'sales', 'thankyou', 'webinar', 'checkout', 'survey']),

  // Optional public_id suggestion to pre-populate Page registration UI
  suggested_public_id: z.string().optional(),

  // Canonical and custom events expected on this page
  event_config: z.object({
    canonical: z.array(z.string()),
    custom: z.array(z.string()),
  }),

  // Optional funnel-role hint for dispatch / audience segmentation
  suggested_funnel_role: z.enum(['workshop', 'main_offer']).optional(),
});

// ============================================================
// Audience: represents an audience segment scaffolded by this template
// ============================================================
const FunnelAudienceSchema = z.object({
  // Unique identifier within the blueprint
  slug: z.string().min(1),

  // Human-readable name (e.g. 'Compradores — Oferta Principal')
  name: z.string().min(1),

  // Target advertising platform
  platform: z.enum(['meta', 'google', 'internal']),

  // Template for the audience query; placeholders filled at scaffold time
  query_template: z.record(z.unknown()),
});

// ============================================================
// LeadsView: T-LEADS-VIEW-001 — config da Leads tab por launch
// ============================================================

// Source de uma coluna do tipo 'any' (stage OR event) — usada quando a UI
// precisa marcar a célula como verde se qualquer um dos sinais estiver presente.
export const LeadsViewColumnSourceSchema = z.object({
  type: z.enum(['stage', 'event', 'tag']),
  name: z.string().min(1),
});

// Coluna individual exibida na Leads tab.
//   - type='stage'|'event'|'tag': source é o nome do stage/event/tag.
//   - type='any':                  sources é a lista alternativa (OR).
export const LeadsViewColumnSchema = z.object({
  // Identificador da coluna (estável entre versões — UI persiste largura/ordem)
  key: z.string().min(1),

  // Header da coluna
  label: z.string().min(1),

  // Como a célula é resolvida
  type: z.enum(['stage', 'event', 'tag', 'any']),

  // Para type ∈ {'stage','event','tag'}: nome do sinal único.
  source: z.string().min(1).optional(),

  // Para type='any': lista de sinais alternativos (OR).
  sources: z.array(LeadsViewColumnSourceSchema).optional(),
});

export const LeadsViewSchema = z.object({
  // Ordem de progressão dos stages (subset ordenado dos slugs em blueprint.stages)
  stage_progression: z.array(z.string().min(1)),

  // Colunas exibidas na tabela de leads
  columns: z.array(LeadsViewColumnSchema),
});

// ============================================================
// TagRule: T-LEADS-VIEW-001 — evento → tag binding
// Regra: quando `event` ocorrer (e quando `when` casar, se presente),
// setar a tag `tag` no lead. Aplicado pelo service layer (não DB trigger).
// ============================================================
export const TagRuleConditionSchema = z
  .object({
    // Filtro mais comum: funnel_role do evento (workshop|main_offer|...).
    // Outros filtros declarativos são aceitos via passthrough.
    funnel_role: z.string().optional(),
  })
  .passthrough();

export const TagRuleSchema = z.object({
  // Nome do evento (canonical ou `custom:*`).
  event: z.string().min(1),

  // Filtro opcional sobre o payload do evento (ex.: funnel_role).
  when: TagRuleConditionSchema.optional(),

  // Nome da tag a ser setada. Insertada com ON CONFLICT DO NOTHING — idempotente.
  tag: z.string().min(1),
});

// ============================================================
// FunnelBlueprintSchema: top-level schema
// ============================================================
export const FunnelBlueprintSchema = z.object({
  // Funnel archetype — determines which stages/pages are expected
  type: z.enum(['lancamento_gratuito', 'lancamento_pago', 'evergreen']),

  // Whether this funnel includes a paid main offer page
  has_main_offer: z.boolean(),

  // Whether this funnel includes a live or recorded workshop/webinar
  has_workshop: z.boolean(),

  // Checkout variant (required when has_main_offer=true)
  checkout_variant: z
    .enum(['direto_guru', 'checkout_proprio', 'com_popup'])
    .optional(),

  // Ordered list of funnel stages
  stages: z.array(FunnelStageSchema),

  // Pages associated with this funnel
  pages: z.array(FunnelPageSchema),

  // Audience segments scaffolded by this template
  audiences: z.array(FunnelAudienceSchema),

  // T-LEADS-VIEW-001: configuração da Leads tab. Optional — blueprints
  // anteriores à migration 0044 não têm essa key (UI faz fallback).
  leads_view: LeadsViewSchema.optional(),

  // T-LEADS-VIEW-001: regras evento → tag. Optional pelo mesmo motivo.
  tag_rules: z.array(TagRuleSchema).optional(),
});

export type FunnelBlueprint = z.infer<typeof FunnelBlueprintSchema>;
export type FunnelStage = z.infer<typeof FunnelStageSchema>;
export type FunnelPage = z.infer<typeof FunnelPageSchema>;
export type FunnelAudience = z.infer<typeof FunnelAudienceSchema>;
export type LeadsView = z.infer<typeof LeadsViewSchema>;
export type LeadsViewColumn = z.infer<typeof LeadsViewColumnSchema>;
export type LeadsViewColumnSource = z.infer<typeof LeadsViewColumnSourceSchema>;
export type TagRule = z.infer<typeof TagRuleSchema>;
export type TagRuleCondition = z.infer<typeof TagRuleConditionSchema>;
