/**
 * mapper.ts — Pure mapping functions for Hotmart webhook payloads.
 *
 * T-ID: T-9-001
 * Spec: docs/40-integrations/07-hotmart-webhook.md
 *
 * These functions are intentionally pure (no I/O) so they are trivially
 * testable with fixtures. All DB interaction and lead resolution happens
 * in the ingestion processor, not here.
 *
 * BRs applied:
 *   BR-WEBHOOK-002: event_id derived deterministically from platform fields
 *   BR-WEBHOOK-003: unknown/skippable events return skip result, not error
 *   BR-WEBHOOK-004: lead association hierarchy (lead_public_id → order_id → email → phone)
 *   BR-PRIVACY-001: PII fields (email, phone, name) passed as raw strings to processor
 *                   — hashing happens in lead-resolver, NOT here
 */

import type { HotmartWebhookPayload } from './types.js';

// ---------------------------------------------------------------------------
// Result type (mirrors lib/idempotency.ts for consistency)
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Internal event types
// ---------------------------------------------------------------------------

/** Canonical internal event types produced by the Hotmart mapper. */
export type HotmartEventType =
  | 'Purchase'
  | 'RefundProcessed'
  | 'Chargeback'
  | 'InitiateCheckout';

/**
 * Internal event shape passed to the ingestion processor.
 *
 * Monetary values are in centavos (as received from Hotmart — integer cents).
 * PII fields are raw strings — the lead-resolver hashes them.
 */
export interface InternalEvent {
  /** Deterministic 32-char hex event ID — BR-WEBHOOK-002 */
  event_id: string;
  /** Canonical event type */
  event_type: HotmartEventType;
  /** Platform that originated this event */
  platform: 'hotmart';
  /** Original platform event ID (Hotmart transaction code) */
  platform_event_id: string;
  /** ISO-8601 timestamp derived from creation_date epoch ms */
  occurred_at: string;
  /** Custom data extracted from the purchase */
  custom_data: {
    /** Hotmart transaction code (order ID) */
    order_id: string;
    /** Purchase value in centavos (integer) */
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
    /** GlobalTracker lead_public_id from metadata — highest priority (BR-WEBHOOK-004) */
    lead_public_id?: string | null;
    /** BR-PRIVACY-001: PII — passed as-is; processor hashes */
    email?: string | null;
    /** BR-PRIVACY-001: PII — passed as-is; processor hashes */
    phone?: string | null;
    /** BR-PRIVACY-001: PII — passed as-is */
    name?: string | null;
  };
  /** UTM attribution extracted from purchase.tracking + purchase.utms */
  attribution?: {
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
    utm_content?: string | null;
    utm_term?: string | null;
    /** Hotmart source_sck — secondary click ID */
    source_sck?: string | null;
    /** External reference passed through Hotmart tracking */
    external_reference?: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Mapping error types
// ---------------------------------------------------------------------------

export type MappingError =
  | { code: 'unknown_event_type'; event_type: string }
  | { code: 'missing_required_field'; field: string }
  | { code: 'invalid_payload'; reason: string };

/**
 * Skip result — returned for events that are deliberately ignored
 * (SUBSCRIPTION_CANCELLATION is Phase 3+).
 * BR-WEBHOOK-003: these do NOT become failed raw_events; the handler
 * returns 202 without inserting anything.
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
 * BR-WEBHOOK-002: event_id = sha256("hotmart:" + transaction + ":" + event_type)[:32]
 *
 * Uses Web Crypto API (available in Cloudflare Workers and modern test envs).
 */
export async function deriveHotmartEventId(
  transaction: string,
  eventType: string,
): Promise<string> {
  const input = `hotmart:${transaction}:${eventType}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  // BR-WEBHOOK-002: truncate to 32 chars
  return hex.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Hotmart event → internal event type mapping
// ---------------------------------------------------------------------------

/**
 * Maps Hotmart event type strings to canonical internal event types.
 * Returns null for explicitly skippable events, undefined for unknown.
 */
function resolveInternalEventType(
  hotmartEvent: string,
): HotmartEventType | 'skip' | null {
  switch (hotmartEvent) {
    case 'PURCHASE_APPROVED':
      return 'Purchase';
    case 'PURCHASE_REFUNDED':
      return 'RefundProcessed';
    case 'PURCHASE_CHARGEBACK':
      return 'Chargeback';
    case 'PURCHASE_PROTEST':
      // Protest maps to Chargeback per spec
      return 'Chargeback';
    case 'PURCHASE_BILLET_PRINTED':
      return 'InitiateCheckout';
    case 'SUBSCRIPTION_CANCELLATION':
      // Phase 3+ — skip for now (BR-WEBHOOK-003)
      return 'skip';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Main mapper
// ---------------------------------------------------------------------------

/**
 * Maps a Hotmart webhook payload to an internal event.
 *
 * BR-WEBHOOK-002: event_id derived deterministically from transaction + event.
 * BR-WEBHOOK-003: SUBSCRIPTION_CANCELLATION returns skip; unknown events return error.
 * BR-WEBHOOK-004: lead_hints populated in priority order.
 * BR-PRIVACY-001: PII fields passed as raw strings for processor to hash.
 */
export async function mapHotmartToInternal(
  payload: HotmartWebhookPayload,
): Promise<MapResult> {
  // Validate required fields
  if (!payload.event) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'event' },
    };
  }

  if (!payload.data?.purchase?.transaction) {
    return {
      ok: false,
      error: {
        code: 'missing_required_field',
        field: 'data.purchase.transaction',
      },
    };
  }

  if (!payload.data?.buyer?.email) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'data.buyer.email' },
    };
  }

  const hotmartEvent = payload.event;
  const resolved = resolveInternalEventType(hotmartEvent);

  // BR-WEBHOOK-003: explicitly skippable events (Phase 3+)
  if (resolved === 'skip') {
    return {
      ok: false,
      skip: true,
      reason: `Hotmart event '${hotmartEvent}' is not processed in Phase 2 (Phase 3+ only)`,
    };
  }

  // BR-WEBHOOK-003: unknown event type → error result (processor marks as failed)
  if (resolved === null) {
    return {
      ok: false,
      error: {
        code: 'unknown_event_type',
        event_type: hotmartEvent,
      },
    };
  }

  const event_type = resolved;
  const transaction = payload.data.purchase.transaction;

  // BR-WEBHOOK-002: derive deterministic event_id
  const event_id = await deriveHotmartEventId(transaction, hotmartEvent);

  // ISO-8601 timestamp from creation_date (epoch ms)
  const occurred_at = payload.creation_date
    ? new Date(payload.creation_date).toISOString()
    : new Date().toISOString();

  // Attribution: merge tracking + utms (utms take precedence for standard UTM fields)
  const tracking = payload.data.purchase.tracking ?? null;
  const utms = payload.data.purchase.utms ?? null;

  const attribution =
    tracking !== null || utms !== null
      ? {
          utm_source: utms?.utm_source ?? tracking?.source ?? null,
          utm_medium: utms?.utm_medium ?? null,
          utm_campaign: utms?.utm_campaign ?? null,
          utm_content: utms?.utm_content ?? null,
          utm_term: utms?.utm_term ?? null,
          source_sck: tracking?.source_sck ?? null,
          external_reference: tracking?.external_reference ?? null,
        }
      : null;

  const event: InternalEvent = {
    event_id,
    event_type,
    platform: 'hotmart',
    platform_event_id: transaction,
    occurred_at,
    custom_data: {
      order_id: transaction,
      // BR-WEBHOOK-004 / spec: value stored in centavos (as received)
      value: payload.data.purchase.price.value,
      currency: payload.data.purchase.price.currency_value,
    },
    // BR-WEBHOOK-004: lead_hints in priority order
    // 1. metadata.lead_public_id (GlobalTracker pass-through — highest priority)
    // 2. email (for order_id lookup by processor)
    // 3. phone
    // BR-PRIVACY-001: raw PII — processor hashes
    lead_hints: {
      lead_public_id: payload.metadata?.lead_public_id ?? null,
      email: payload.data.buyer.email,
      phone: payload.data.buyer.checkout_phone ?? null,
      name: payload.data.buyer.name,
    },
    attribution,
  };

  return { ok: true, value: event };
}
