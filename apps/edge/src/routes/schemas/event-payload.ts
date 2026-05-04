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

const AttributionSchema = z
  .object({
    utm_source: z.string().optional(),
    utm_medium: z.string().optional(),
    utm_campaign: z.string().optional(),
    utm_content: z.string().optional(),
    utm_term: z.string().optional(),
    fbclid: z.string().optional(),
    gclid: z.string().optional(),
    referrer: z.string().optional(),
  })
  .default({});

const ConsentSchema = z.object({
  analytics: z.boolean().default(false),
  marketing: z.boolean().default(false),
  functional: z.boolean().default(true),
});

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
