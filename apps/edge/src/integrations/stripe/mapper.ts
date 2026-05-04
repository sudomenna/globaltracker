/**
 * mapper.ts — Pure mapping functions for Stripe webhook payloads.
 *
 * T-ID: T-9-003
 * Spec: docs/40-integrations/09-stripe-webhook.md
 *
 * These functions are intentionally pure (no I/O) so they are trivially
 * testable with fixtures. All DB interaction and lead resolution happens
 * in the ingestion processor, not here.
 *
 * BRs applied:
 *   BR-WEBHOOK-002: event_id derived deterministically from platform fields
 *   BR-WEBHOOK-003: unknown event types return error result, not 4xx
 *   BR-WEBHOOK-004: lead association hierarchy:
 *                   metadata.lead_public_id → client_reference_id → email hash
 *   BR-PRIVACY-001: PII fields (email, phone, name) passed as raw strings to
 *                   processor — hashing happens in lead-resolver, NOT here
 */

import {
  isStripeCharge,
  isStripeCheckoutSession,
  isStripePaymentIntent,
} from './types.js';
import type { StripeEvent } from './types.js';

// ---------------------------------------------------------------------------
// Result type (mirrors lib/idempotency.ts for consistency)
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Internal event types
// ---------------------------------------------------------------------------

/** Canonical internal event types produced by the Stripe mapper. */
export type StripeEventType =
  | 'Purchase'
  | 'PaymentCompleted'
  | 'RefundProcessed';

/**
 * Internal event shape passed to the ingestion processor.
 *
 * Monetary values are in cents (Stripe's native unit).
 * PII fields are raw strings — the lead-resolver hashes them.
 */
export interface InternalEvent {
  /** Deterministic 32-char hex event ID — BR-WEBHOOK-002 */
  event_id: string;
  /** Canonical event type */
  event_type: StripeEventType;
  /** Platform that originated this event */
  platform: 'stripe';
  /** Original Stripe event ID (evt_xxx) */
  platform_event_id: string;
  /** ISO-8601 timestamp from the event.created field */
  occurred_at: string;
  /** Amount in cents (Stripe native unit) */
  amount?: number | null;
  /** Currency code — uppercase (ISO 4217) */
  currency?: string | null;
  /**
   * Lead association hints — BR-WEBHOOK-004.
   * The ingestion processor resolves these to a lead_id in priority order.
   * BR-PRIVACY-001: raw strings; processor hashes before persisting in lead_aliases.
   */
  lead_hints: {
    /** metadata.lead_public_id — highest priority (BR-WEBHOOK-004 prio 1) */
    lead_public_id?: string | null;
    /** client_reference_id — second priority (BR-WEBHOOK-004 prio 2) */
    client_reference_id?: string | null;
    /** BR-PRIVACY-001: PII — passed as-is; processor hashes */
    email?: string | null;
    /** BR-PRIVACY-001: PII — passed as-is; processor hashes */
    phone?: string | null;
    /** BR-PRIVACY-001: PII — passed as-is; processor hashes */
    name?: string | null;
  };
  /** UTM attribution extracted from metadata */
  attribution?: {
    utm_source?: string | null;
    utm_campaign?: string | null;
    utm_medium?: string | null;
    utm_content?: string | null;
    utm_term?: string | null;
  } | null;
  /** Custom data for downstream processors */
  custom_data?: {
    order_id?: string | null;
    value?: number | null;
    currency?: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Mapping error types
// ---------------------------------------------------------------------------

export type MappingError =
  | { code: 'unknown_event_type'; event_type: string }
  | { code: 'missing_required_field'; field: string }
  | { code: 'invalid_payload'; reason: string };

export type MapResult =
  | { ok: true; value: InternalEvent }
  | { ok: false; error: MappingError };

// ---------------------------------------------------------------------------
// Idempotency key derivation
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic 32-char hex event_id from the Stripe event ID.
 *
 * BR-WEBHOOK-002: event_id = sha256("stripe:" + event.id)[:32]
 *
 * Stripe event.id is globally unique (evt_xxx), so no additional discriminator
 * is needed (unlike Guru which uses webhook_type + id + status).
 *
 * Uses Web Crypto API (available in Cloudflare Workers and modern test envs).
 */
export async function deriveStripeEventId(stripeEventId: string): Promise<string> {
  const input = `stripe:${stripeEventId}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  // BR-WEBHOOK-002: truncate to 32 chars
  return hex.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Main mapper
// ---------------------------------------------------------------------------

/**
 * Maps a Stripe event payload to an internal event.
 *
 * Supported event types:
 *   checkout.session.completed → Purchase
 *   payment_intent.succeeded   → PaymentCompleted
 *   charge.refunded            → RefundProcessed
 *
 * Unknown event types → error result (BR-WEBHOOK-003):
 *   handler persists as processing_status='failed' + returns 200.
 *
 * BR-WEBHOOK-004: lead_hints populated in priority order.
 * BR-PRIVACY-001: PII fields passed as raw strings for processor to hash.
 */
export async function mapStripeToInternal(
  event: StripeEvent,
): Promise<MapResult> {
  // Validate required fields
  if (!event.id) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'id' },
    };
  }
  if (!event.type) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'type' },
    };
  }

  // BR-WEBHOOK-002: derive deterministic event_id
  const event_id = await deriveStripeEventId(event.id);

  // Occurred_at from event.created (epoch seconds → ISO-8601)
  const occurred_at = new Date(event.created * 1000).toISOString();

  const dataObject = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      if (!isStripeCheckoutSession(dataObject)) {
        return {
          ok: false,
          error: { code: 'invalid_payload', reason: 'data.object is not a checkout.session' },
        };
      }

      // BR-WEBHOOK-004: lead_hints hierarchy
      // Priority 1: metadata.lead_public_id
      // Priority 2: client_reference_id
      // Priority 3: customer_email / customer_details.email
      const email =
        dataObject.customer_details?.email ?? dataObject.customer_email ?? null;
      const phone = dataObject.customer_details?.phone ?? null;
      const name = dataObject.customer_details?.name ?? null;

      // UTM attribution from metadata
      const meta = dataObject.metadata ?? {};
      const attribution = extractAttribution(meta);

      return {
        ok: true,
        value: {
          event_id,
          event_type: 'Purchase',
          platform: 'stripe',
          platform_event_id: event.id,
          occurred_at,
          amount: dataObject.amount_total ?? null,
          currency: dataObject.currency?.toUpperCase() ?? null,
          // BR-WEBHOOK-004: lead_hints in priority order
          // BR-PRIVACY-001: raw PII — processor hashes
          lead_hints: {
            lead_public_id: meta['lead_public_id'] ?? null,
            client_reference_id: dataObject.client_reference_id ?? null,
            email,
            phone,
            name,
          },
          attribution,
          custom_data: {
            order_id: event.id,
            value: dataObject.amount_total ?? null,
            currency: dataObject.currency?.toUpperCase() ?? null,
          },
        },
      };
    }

    case 'payment_intent.succeeded': {
      if (!isStripePaymentIntent(dataObject)) {
        return {
          ok: false,
          error: { code: 'invalid_payload', reason: 'data.object is not a payment_intent' },
        };
      }

      const meta = dataObject.metadata ?? {};
      const attribution = extractAttribution(meta);

      return {
        ok: true,
        value: {
          event_id,
          event_type: 'PaymentCompleted',
          platform: 'stripe',
          platform_event_id: event.id,
          occurred_at,
          amount: dataObject.amount,
          currency: dataObject.currency.toUpperCase(),
          // BR-WEBHOOK-004: lead_hints from metadata and receipt_email
          // BR-PRIVACY-001: raw PII — processor hashes
          lead_hints: {
            lead_public_id: meta['lead_public_id'] ?? null,
            client_reference_id: null,
            email: dataObject.receipt_email ?? null,
            phone: null,
            name: null,
          },
          attribution,
          custom_data: {
            order_id: event.id,
            value: dataObject.amount,
            currency: dataObject.currency.toUpperCase(),
          },
        },
      };
    }

    case 'charge.refunded': {
      if (!isStripeCharge(dataObject)) {
        return {
          ok: false,
          error: { code: 'invalid_payload', reason: 'data.object is not a charge' },
        };
      }

      const meta = dataObject.metadata ?? {};
      const attribution = extractAttribution(meta);

      // BR-PRIVACY-001: PII from billing_details
      const email = dataObject.billing_details?.email ?? null;
      const phone = dataObject.billing_details?.phone ?? null;
      const name = dataObject.billing_details?.name ?? null;

      return {
        ok: true,
        value: {
          event_id,
          event_type: 'RefundProcessed',
          platform: 'stripe',
          platform_event_id: event.id,
          occurred_at,
          amount: dataObject.amount_refunded,
          currency: dataObject.currency.toUpperCase(),
          // BR-WEBHOOK-004: lead_hints from metadata and billing_details
          // BR-PRIVACY-001: raw PII — processor hashes
          lead_hints: {
            lead_public_id: meta['lead_public_id'] ?? null,
            client_reference_id: null,
            email,
            phone,
            name,
          },
          attribution,
          custom_data: {
            order_id: event.id,
            value: dataObject.amount_refunded,
            currency: dataObject.currency.toUpperCase(),
          },
        },
      };
    }

    default:
      // BR-WEBHOOK-003: unknown event type → error result
      // handler persists as processing_status='failed' + returns 200 (not 4xx)
      return {
        ok: false,
        error: { code: 'unknown_event_type', event_type: event.type },
      };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts UTM attribution fields from Stripe metadata.
 * Returns null if no UTM fields are present.
 */
function extractAttribution(
  meta: Record<string, string | null>,
): InternalEvent['attribution'] {
  const utm_source = meta['utm_source'] ?? null;
  const utm_campaign = meta['utm_campaign'] ?? null;
  const utm_medium = meta['utm_medium'] ?? null;
  const utm_content = meta['utm_content'] ?? null;
  const utm_term = meta['utm_term'] ?? null;

  if (
    utm_source === null &&
    utm_campaign === null &&
    utm_medium === null &&
    utm_content === null &&
    utm_term === null
  ) {
    return null;
  }

  return { utm_source, utm_campaign, utm_medium, utm_content, utm_term };
}
