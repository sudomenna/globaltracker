/**
 * EventPayloadSchema — Zod schema for POST /v1/events body.
 *
 * CONTRACT-id: CONTRACT-api-events-v1
 *
 * BR-EVENT-004: lead_token and lead_id are mutually exclusive.
 * BR-PRIVACY-001: schema uses .strict() to reject unknown fields (no PII leakage
 *   through unexpected fields).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

// tracker.js sends null (not undefined) for unset fields; accept both.
const AttributionSchema = z
  .object({
    utm_source: z.string().nullish(),
    utm_medium: z.string().nullish(),
    utm_campaign: z.string().nullish(),
    utm_content: z.string().nullish(),
    utm_term: z.string().nullish(),
    fbclid: z.string().nullish(),
    gclid: z.string().nullish(),
    referrer: z.string().nullish(),
  })
  .default({});

// analytics/marketing accept either boolean (legacy/CP) or GA-style string
// ('granted'/'denied'/'unknown'). tracker.js sends strings; we normalize to boolean
// so downstream consumers (consent.ts, lead.ts, raw-events-processor) stay simple.
const BoolOrConsentString = z
  .union([z.boolean(), z.enum(['granted', 'denied', 'unknown'])])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'granted'));

const ConsentSchema = z.object({
  analytics: BoolOrConsentString.default(false),
  marketing: BoolOrConsentString.default(false),
  functional: z.boolean().default(true),
  ad_user_data: z.enum(['granted', 'denied', 'unknown']).optional(),
  ad_personalization: z.enum(['granted', 'denied', 'unknown']).optional(),
  customer_match: z.enum(['granted', 'denied', 'unknown']).optional(),
});

/**
 * Platform cookies forwarded from the tracker to the Edge for Meta CAPI / GA4 / Google Ads.
 *
 * BR-PRIVACY-001 (revisada): além de identificadores opacos (fbp, fbc, _ga, _gcl_au),
 * agora aceita também `client_ip_address` e `client_user_agent`. Esses campos serão
 * sobrescritos pelo handler com os headers reais do request (CF-Connecting-IP /
 * User-Agent) antes do insert em raw_events — Meta CAPI / Google Enhanced Conversions
 * exigem esses valores não-hasheados para EMQ (Event Match Quality). O tracker
 * normalmente não tem acesso ao IP real, mas mantemos o schema permissivo para
 * idempotência e debug.
 *
 * IMPORTANTE — `visitor_id` NÃO entra aqui. O tracker envia `visitor_id` no
 * TOP-LEVEL do payload (`EventPayloadSchema.visitor_id` abaixo) e o
 * raw-events-processor extrai pra coluna dedicada `events.visitor_id`. Meta CAPI
 * mapper (`apps/edge/src/dispatchers/meta-capi/mapper.ts`) lê `event.visitor_id`
 * (coluna) e mapeia para `userData.external_id` em plano (ADR-031). Não procure
 * por `external_id` ou `fvid` dentro de `user_data` — esses campos não existem
 * aqui e seriam stripados por INV-EVENT-004 ("only canonical keys").
 * Ver docs/20-domain/04-mod-identity.md §7 "Storage de visitor_id".
 */
const UserDataSchema = z
  .object({
    _gcl_au: z.string().nullable().optional(),
    _ga: z.string().nullable().optional(),
    fbc: z.string().nullable().optional(),
    fbp: z.string().nullable().optional(),
    client_ip_address: z.string().nullish(),
    client_user_agent: z.string().nullish(),
  })
  .default({});

// ---------------------------------------------------------------------------
// Main payload schema
// ---------------------------------------------------------------------------

/**
 * Full event payload accepted by POST /v1/events.
 *
 * CONTRACT-api-events-v1: body schema.
 *
 * `.strict()` rejects unknown fields — least-surprise + prevents PII smuggling.
 *
 * `.refine()`: lead_token and lead_id are mutually exclusive.
 * BR-EVENT-004: lead_token HMAC validated separately in handler when present.
 */
export const EventPayloadSchema = z
  .object({
    event_id: z.string().min(1).max(64),
    schema_version: z.literal(1),
    launch_public_id: z.string(),
    page_public_id: z.string(),
    event_name: z.string().min(1).max(100),
    event_time: z.string().datetime(),
    lead_token: z.string().optional(),
    lead_id: z.string().uuid().optional(),
    visitor_id: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    external_id: z.string().optional(),
    attribution: AttributionSchema,
    user_data: UserDataSchema,
    custom_data: z.record(z.unknown()).default({}),
    consent: ConsentSchema,
  })
  .strict()
  .refine((d) => !(d.lead_token && d.lead_id), {
    // BR-EVENT-004: lead_token and lead_id are mutually exclusive;
    // browser must use lead_token; lead_id in clear is admin-only.
    message: 'lead_token and lead_id are mutually exclusive',
  });

export type EventPayload = z.infer<typeof EventPayloadSchema>;
