import { z } from 'zod';

// T-FUNIL-010: Canonical Zod schema for funnel blueprint stored in funnel_templates.blueprint
// and snapshotted in launches.funnel_blueprint.
//
// Shape reflects Sprint 10 roadmap — FunnelBlueprintSchema is the source of truth
// for validating jsonb before any DB write.

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
});

export type FunnelBlueprint = z.infer<typeof FunnelBlueprintSchema>;
export type FunnelStage = z.infer<typeof FunnelStageSchema>;
export type FunnelPage = z.infer<typeof FunnelPageSchema>;
export type FunnelAudience = z.infer<typeof FunnelAudienceSchema>;
