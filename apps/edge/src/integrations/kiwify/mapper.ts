/**
 * mapper.ts — Pure mapping functions for Kiwify webhook payloads.
 *
 * T-ID: T-9-002
 * Spec: docs/40-integrations/08-kiwify-webhook.md
 * Contracts: docs/30-contracts/04-webhook-contracts.md
 *
 * These functions are intentionally pure (no I/O) so they are trivially
 * testable with fixtures. All DB interaction and lead resolution happens
 * in the ingestion processor, not here.
 *
 * BRs applied:
 *   BR-WEBHOOK-002: event_id derived deterministically from platform fields
 *   BR-WEBHOOK-003: unknown/skip event_types return skip result, not error
 *   BR-WEBHOOK-004: lead association hierarchy:
 *                     metadata.lead_public_id → order.client_ref (if ldr_) →
 *                     order.id → customer.email → customer.mobile/phone
 *   BR-PRIVACY-001: PII fields (email, phone, name) passed as raw strings to
 *                   processor — hashing happens in lead-resolver, NOT here
 */

import type { KiwifyWebhookPayload } from './types.js';

// ---------------------------------------------------------------------------
// Result type (mirrors lib/idempotency.ts for consistency)
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Internal event types
// ---------------------------------------------------------------------------

/** Canonical internal event types produced by the Kiwify mapper. */
export type KiwifyEventTypeMapped =
  | 'Purchase'
  | 'RefundProcessed'
  | 'InitiateCheckout';

/**
 * Internal event shape passed to the ingestion processor.
 *
 * Monetary values are in cents (as received from Kiwify — no conversion needed
 * since raw cents are stored in custom_data.value).
 * PII fields are raw strings — the lead-resolver hashes them.
 */
export interface InternalEvent {
  /** Deterministic 32-char hex event ID — BR-WEBHOOK-002 */
  event_id: string;
  /** Canonical event type */
  event_type: KiwifyEventTypeMapped;
  /** Platform that originated this event */
  platform: 'kiwify';
  /** Original platform event ID (order.id) */
  platform_event_id: string;
  /** ISO-8601 timestamp — Kiwify does not send one; use ingestion time */
  occurred_at: string;
  /** Kiwify-specific custom data */
  custom_data: {
    /** Order ID from Kiwify */
    order_id: string;
    /** Order total in cents */
    value: number;
    /** ISO 4217 currency code */
    currency: string;
  };
  /**
   * Lead association hints — BR-WEBHOOK-004.
   * The ingestion processor resolves these to a lead_id in priority order.
   * BR-PRIVACY-001: raw strings; processor hashes before persisting in lead_aliases.
   */
  lead_hints: {
    /** metadata.lead_public_id or order.client_ref (if ldr_ prefix) — highest priority */
    lead_public_id?: string | null;
    /** BR-PRIVACY-001: PII — passed as-is; processor hashes */
    email?: string | null;
    /** BR-PRIVACY-001: PII — passed as-is; processor hashes */
    phone?: string | null;
    /** BR-PRIVACY-001: PII — customer name for context only */
    name?: string | null;
  };
  /** UTM attribution extracted from order.tracking */
  attribution?: {
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
    utm_content?: string | null;
    utm_term?: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Mapping error types
// ---------------------------------------------------------------------------

export type MappingError =
  | { code: 'missing_required_field'; field: string }
  | { code: 'invalid_payload'; reason: string };

/**
 * Skip result — returned for event_types deliberately ignored in the current phase
 * (e.g. subscription.canceled — Phase 3+).
 * BR-WEBHOOK-003: these do NOT become failed raw_events; the handler
 * returns 200 without inserting anything (stop provider retrying).
 */
export interface SkipResult {
  ok: false;
  skip: true;
  reason: string;
}

export type MapResult =
  | { ok: true; value: InternalEvent }
  | SkipResult
  | { ok: false; skip?: false; error: MappingError };

// ---------------------------------------------------------------------------
// Idempotency key derivation
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic 32-char hex event_id.
 *
 * BR-WEBHOOK-002: event_id = sha256("kiwify:" + order.id + ":" + event_type)[:32]
 *
 * Uses Web Crypto API (available in Cloudflare Workers and modern test envs).
 */
export async function deriveKiwifyEventId(
  orderId: string,
  eventType: string,
): Promise<string> {
  const input = `kiwify:${orderId}:${eventType}`;
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
 * Maps a Kiwify webhook payload to an internal event.
 *
 * BR-WEBHOOK-003: subscription.canceled and unknown event_types return skip result.
 * BR-WEBHOOK-004: lead_hints populated in priority order:
 *   1. metadata.lead_public_id
 *   2. order.client_ref if starts with 'ldr_'
 *   3. customer.email (hash by processor)
 *   4. customer.mobile or customer.phone (hash by processor)
 * BR-PRIVACY-001: PII fields passed as raw strings for processor to hash.
 */
export async function mapKiwifyToInternal(
  payload: KiwifyWebhookPayload,
): Promise<MapResult> {
  const eventType = payload.event_type;

  // BR-WEBHOOK-003: subscription.canceled is Phase 3+ — skip with 200
  if (eventType === 'subscription.canceled') {
    return {
      ok: false,
      skip: true,
      reason: `event_type 'subscription.canceled' is deferred to Phase 3+`,
    };
  }

  // Determine canonical event type
  let mappedEventType: KiwifyEventTypeMapped;
  switch (eventType) {
    case 'order.paid':
      mappedEventType = 'Purchase';
      break;
    case 'order.refunded':
      mappedEventType = 'RefundProcessed';
      break;
    case 'order.created':
      mappedEventType = 'InitiateCheckout';
      break;
    default:
      // BR-WEBHOOK-003: unknown event_type → skip result (200 to caller)
      return {
        ok: false,
        skip: true,
        reason: `unknown event_type: ${eventType}`,
      };
  }

  // Validate required fields
  if (!payload.order?.id) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'order.id' },
    };
  }

  const order = payload.order;

  // BR-WEBHOOK-002: derive deterministic event_id
  const event_id = await deriveKiwifyEventId(order.id, eventType);

  // BR-WEBHOOK-004: lead association hierarchy
  // Priority 1: metadata.lead_public_id
  const metaLeadId = payload.metadata?.lead_public_id ?? null;
  // Priority 2: order.client_ref if it starts with 'ldr_' (GlobalTracker lead token prefix)
  const clientRefLeadId =
    order.client_ref && order.client_ref.startsWith('ldr_')
      ? order.client_ref
      : null;

  const lead_public_id = metaLeadId ?? clientRefLeadId ?? null;

  // Priority 3 & 4: customer email and phone (processor hashes)
  // BR-PRIVACY-001: raw PII — processor hashes before persisting in lead_aliases
  const email = payload.customer?.email ?? null;
  // Prefer mobile over phone (mobile is typically normalized)
  const phone = payload.customer?.mobile ?? payload.customer?.phone ?? null;
  const name = payload.customer?.name ?? null;

  const event: InternalEvent = {
    event_id,
    event_type: mappedEventType,
    platform: 'kiwify',
    platform_event_id: order.id,
    // Kiwify does not include a timestamp in the payload; use ingestion time
    occurred_at: new Date().toISOString(),
    custom_data: {
      order_id: order.id,
      value: order.total_value_cents,
      currency: order.currency,
    },
    // BR-WEBHOOK-004: lead_hints in priority order
    // BR-PRIVACY-001: raw PII — processor hashes
    lead_hints: {
      lead_public_id,
      email,
      phone,
      name,
    },
    attribution: order.tracking
      ? {
          utm_source: order.tracking.utm_source ?? null,
          utm_medium: order.tracking.utm_medium ?? null,
          utm_campaign: order.tracking.utm_campaign ?? null,
          utm_content: order.tracking.utm_content ?? null,
          utm_term: order.tracking.utm_term ?? null,
        }
      : null,
  };

  return { ok: true, value: event };
}
