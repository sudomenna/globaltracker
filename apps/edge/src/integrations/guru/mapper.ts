/**
 * mapper.ts — Pure mapping functions for Digital Manager Guru webhook payloads.
 *
 * T-ID: T-3-004
 * Spec: docs/40-integrations/13-digitalmanager-guru-webhook.md
 *
 * These functions are intentionally pure (no I/O) so they are trivially
 * testable with fixtures. All DB interaction and lead resolution happens
 * in the ingestion processor, not here.
 *
 * BRs applied:
 *   BR-WEBHOOK-002: event_id derived deterministically from platform fields
 *   BR-WEBHOOK-003: unknown/skippable statuses return skip result, not error
 *   BR-WEBHOOK-004: lead association hierarchy (pptc → email → phone → subscriber.email)
 *   BR-PRIVACY-001: PII fields (email, phone, doc) passed as raw strings to processor
 *                   — hashing happens in lead-resolver, NOT here
 */

import type {
  GuruSubscriptionPayload,
  GuruTransactionPayload,
} from './types.js';

// ---------------------------------------------------------------------------
// Result type (mirrors lib/idempotency.ts for consistency)
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Internal event types
// ---------------------------------------------------------------------------

/** Canonical internal event types produced by the Guru mapper. */
export type GuruEventType =
  | 'Purchase'
  | 'RefundProcessed'
  | 'Chargeback'
  | 'OrderCanceled'
  | 'InitiateCheckout'
  | 'SubscriptionActivated'
  | 'SubscriptionCanceled';

/**
 * Internal event shape passed to the ingestion processor.
 *
 * Monetary values are in the base currency unit (not centavos).
 * PII fields are raw strings — the lead-resolver hashes them.
 */
export interface InternalEvent {
  /** Deterministic 32-char hex event ID — BR-WEBHOOK-002 */
  event_id: string;
  /** Canonical event type */
  event_type: GuruEventType;
  /** Platform that originated this event */
  platform: 'guru';
  /** Original platform event ID (transaction UUID or subscription ID) */
  platform_event_id: string;
  /** ISO-8601 timestamp from the platform payload */
  occurred_at: string;
  /** Monetary amount in base unit (e.g. BRL, not centavos) */
  amount?: number | null;
  /** Currency code (ISO 4217) */
  currency?: string | null;
  /** Product information */
  product?: {
    id?: string | null;
    name?: string | null;
    offer_id?: string | null;
    offer_name?: string | null;
  } | null;
  /**
   * Lead association hints — BR-WEBHOOK-004.
   * The ingestion processor resolves these to a lead_id in priority order.
   * BR-PRIVACY-001: raw strings; processor hashes before persisting in lead_aliases.
   */
  lead_hints: {
    /** pptc from source (GlobalTracker lead_public_id) — highest priority */
    lead_public_id?: string | null;
    /** BR-PRIVACY-001: PII — passed as-is; processor hashes */
    email?: string | null;
    /** BR-PRIVACY-001: PII — passed as-is; processor hashes */
    phone?: string | null;
    /** BR-PRIVACY-001: PII (subscriber.email for subscriptions) */
    subscriber_email?: string | null;
  };
  /** UTM attribution extracted from source */
  attribution?: {
    utm_source?: string | null;
    utm_campaign?: string | null;
    utm_medium?: string | null;
    utm_content?: string | null;
    utm_term?: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Mapping error types
// ---------------------------------------------------------------------------

export type MappingError =
  | { code: 'unknown_status'; status: string; webhook_type: string }
  | { code: 'missing_required_field'; field: string }
  | { code: 'invalid_payload'; reason: string };

/**
 * Skip result — returned for statuses that are deliberately ignored
 * (waiting_payment, expired, overdue).
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
 * BR-WEBHOOK-002: event_id = sha256("guru:" + webhook_type + ":" + id + ":" + status)[:32]
 *
 * Uses Web Crypto API (available in Cloudflare Workers and modern test envs).
 */
export async function deriveGuruEventId(
  webhookType: string,
  id: string,
  status: string,
): Promise<string> {
  const input = `guru:${webhookType}:${id}:${status}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  // BR-WEBHOOK-002: truncate to 32 chars
  return hex.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Transaction mapper
// ---------------------------------------------------------------------------

/**
 * Maps a Guru `transaction` webhook payload to an internal event.
 *
 * BR-WEBHOOK-003: waiting_payment and expired return skip result.
 * BR-WEBHOOK-004: lead_hints populated in priority order.
 * BR-PRIVACY-001: PII fields passed as raw strings for processor to hash.
 */
export async function mapGuruTransactionToInternal(
  payload: GuruTransactionPayload,
): Promise<MapResult> {
  // Validate required fields
  if (!payload.id) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'id' },
    };
  }
  if (!payload.status) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'status' },
    };
  }

  const status = payload.status;

  // BR-WEBHOOK-003: explicitly skippable statuses — do not insert raw_event
  if (status === 'waiting_payment' || status === 'expired') {
    return {
      ok: false,
      skip: true,
      reason: `transaction status '${status}' is deliberately ignored`,
    };
  }

  // Map status to canonical event type
  let event_type: GuruEventType;
  switch (status) {
    case 'approved':
      event_type = 'Purchase';
      break;
    case 'refunded':
      event_type = 'RefundProcessed';
      break;
    case 'chargedback':
      event_type = 'Chargeback';
      break;
    case 'canceled':
      event_type = 'OrderCanceled';
      break;
    // BR-WEBHOOK-003: abandoned = checkout started but not completed → InitiateCheckout
    // Conforms to CartAbandonmentInternalEvent canonical contract (shared/cart-abandonment.ts).
    // amount = payment.total / 100 (intended offer price, not confirmed payment).
    case 'abandoned':
      event_type = 'InitiateCheckout';
      break;
    default:
      // BR-WEBHOOK-003: unknown status → error result (processor marks as failed)
      return {
        ok: false,
        error: {
          code: 'unknown_status',
          status,
          webhook_type: 'transaction',
        },
      };
  }

  // BR-WEBHOOK-002: derive deterministic event_id
  const event_id = await deriveGuruEventId('transaction', payload.id, status);

  // Monetary conversion: centavos → base unit
  // Spec: payment.total / 100 (e.g. 29700 → 297.00)
  const amount =
    typeof payload.payment?.total === 'number'
      ? payload.payment.total / 100
      : null;

  // BR-WEBHOOK-004: lead association hierarchy
  // Priority: source.pptc (lead_public_id) → contact.email → contact.phone
  const phone =
    payload.contact?.phone_local_code && payload.contact?.phone_number
      ? `${payload.contact.phone_local_code}${payload.contact.phone_number}`
      : (payload.contact?.phone_number ?? null);

  const event: InternalEvent = {
    event_id,
    event_type,
    platform: 'guru',
    platform_event_id: payload.id,
    // BR-WEBHOOK-004: use confirmed_at if available, else created_at, else now
    occurred_at:
      payload.confirmed_at ?? payload.created_at ?? new Date().toISOString(),
    amount,
    currency: payload.payment?.currency ?? null,
    product: payload.product
      ? {
          id: payload.product.id ?? null,
          name: payload.product.name ?? null,
          offer_id: payload.product.offer?.id ?? null,
          offer_name: payload.product.offer?.name ?? null,
        }
      : null,
    // BR-WEBHOOK-004: lead_hints in priority order
    // BR-PRIVACY-001: raw PII — processor hashes
    lead_hints: {
      lead_public_id: payload.source?.pptc ?? null,
      email: payload.contact?.email ?? null,
      phone,
    },
    attribution: payload.source
      ? {
          utm_source: payload.source.utm_source ?? null,
          utm_campaign: payload.source.utm_campaign ?? null,
          utm_medium: payload.source.utm_medium ?? null,
          utm_content: payload.source.utm_content ?? null,
          utm_term: payload.source.utm_term ?? null,
        }
      : null,
  };

  return { ok: true, value: event };
}

// ---------------------------------------------------------------------------
// Subscription mapper
// ---------------------------------------------------------------------------

/**
 * Maps a Guru `subscription` webhook payload to an internal event.
 *
 * BR-WEBHOOK-003: overdue and unknown statuses handled appropriately.
 * BR-WEBHOOK-004: lead_hints include subscriber.email as fallback.
 * BR-PRIVACY-001: PII fields passed as raw strings.
 */
export async function mapGuruSubscriptionToInternal(
  payload: GuruSubscriptionPayload,
): Promise<MapResult> {
  // Validate required fields
  if (!payload.id) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'id' },
    };
  }
  if (!payload.last_status) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'last_status' },
    };
  }

  const status = payload.last_status;

  // BR-WEBHOOK-003: overdue is explicitly ignored in Fase 3
  if (status === 'overdue') {
    return {
      ok: false,
      skip: true,
      reason: `subscription status 'overdue' is ignored in Fase 3`,
    };
  }

  // Map status to canonical event type
  let event_type: GuruEventType;
  switch (status) {
    case 'active':
      event_type = 'SubscriptionActivated';
      break;
    case 'canceled':
      event_type = 'SubscriptionCanceled';
      break;
    default:
      // BR-WEBHOOK-003: unknown status → error result (processor marks as failed)
      return {
        ok: false,
        error: {
          code: 'unknown_status',
          status,
          webhook_type: 'subscription',
        },
      };
  }

  // BR-WEBHOOK-002: derive deterministic event_id
  // Spec: for subscription, id = subscription id (e.g. sub_BOAEj2WTKoclmg4X)
  const event_id = await deriveGuruEventId('subscription', payload.id, status);

  // Invoice value in base unit (centavos → BRL)
  const amount =
    typeof payload.current_invoice?.value === 'number'
      ? payload.current_invoice.value / 100
      : null;

  // BR-WEBHOOK-004: lead association hierarchy for subscriptions
  // subscriber.email is the 4th-priority hint per the spec
  const event: InternalEvent = {
    event_id,
    event_type,
    platform: 'guru',
    platform_event_id: payload.id,
    occurred_at: new Date().toISOString(),
    amount,
    currency: null, // subscription payload does not include currency directly
    product: null,
    // BR-WEBHOOK-004: lead_hints (pptc not available for subscriptions)
    // BR-PRIVACY-001: raw PII — processor hashes
    lead_hints: {
      lead_public_id: null,
      email: null, // contact not present in subscription payload
      phone: null,
      subscriber_email: payload.subscriber?.email ?? null,
    },
    attribution: null,
  };

  return { ok: true, value: event };
}
