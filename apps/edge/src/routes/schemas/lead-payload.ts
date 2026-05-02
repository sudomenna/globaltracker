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

export const ConsentSchema = z.object({
  analytics: z.boolean().default(false),
  marketing: z.boolean().default(false),
  functional: z.boolean().default(true),
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
