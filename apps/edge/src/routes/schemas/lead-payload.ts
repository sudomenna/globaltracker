/**
 * LeadPayloadSchema — Zod schema for POST /v1/lead request body.
 *
 * CONTRACT-id: CONTRACT-api-lead-v1
 *
 * BR-IDENTITY-005: at least one of email or phone is required for lead identification.
 * BR-PRIVACY-001: schema shapes input at the edge; email/phone are never logged.
 */

import { z } from 'zod';

export const AttributionSchema = z
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

// analytics/marketing accept either boolean (legacy/CP) or GA-style string
// ('granted'/'denied'/'unknown'). tracker.js sends strings; we normalize to
// boolean so downstream consumers stay simple. Mesmo padrão de event-payload.ts.
const BoolOrConsentString = z
  .union([z.boolean(), z.enum(['granted', 'denied', 'unknown'])])
  .transform((v) => (typeof v === 'boolean' ? v : v === 'granted'));

export const ConsentSchema = z.object({
  analytics: BoolOrConsentString.default(false),
  marketing: BoolOrConsentString.default(false),
  functional: z.boolean().default(true),
  // GA4/Meta granular consent — tracker.js sends as strings; lead handler does
  // not currently use these (only marketing implies them downstream), but accept
  // them silently to avoid .strict() rejection.
  ad_user_data: z.enum(['granted', 'denied', 'unknown']).optional(),
  ad_personalization: z.enum(['granted', 'denied', 'unknown']).optional(),
  customer_match: z.enum(['granted', 'denied', 'unknown']).optional(),
});

export const LeadPayloadSchema = z
  .object({
    event_id: z.string().min(1).max(64),
    schema_version: z.literal(1),
    launch_public_id: z.string(),
    page_public_id: z.string(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    name: z.string().optional(),
    attribution: AttributionSchema,
    consent: ConsentSchema,
    /**
     * ADR-024: Cloudflare Turnstile response token.
     * Optional for backwards compatibility with dev environments.
     * Stripped from payload before raw_events insert (not a business field).
     */
    cf_turnstile_response: z.string().optional(),
  })
  .strict()
  .refine(
    (d: { email?: string; phone?: string }) => Boolean(d.email ?? d.phone),
    {
      message: 'at least one of email or phone is required',
      path: ['email'],
    },
  );

export type LeadPayload = z.infer<typeof LeadPayloadSchema>;
