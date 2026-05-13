/**
 * mapper.ts — Pure mapping functions for OnProfit webhook payloads.
 *
 * Spec: real payload + status mapping confirmed with usuário (2026-05-09).
 * No canonical doc exists yet under docs/40-integrations/.
 *
 * Pure functions only (no I/O) — DB lookups and lead resolution happen in the
 * processor (lib/onprofit-raw-events-processor.ts).
 *
 * BRs applied:
 *   BR-WEBHOOK-002: event_id derived deterministically from platform fields
 *   BR-WEBHOOK-003: skippable / unknown statuses → skip or error result, never throw
 *   BR-WEBHOOK-004: lead association hierarchy (lead_public_id → email → cell → phone)
 *   BR-PRIVACY-001: PII fields passed as raw strings to processor — hashing happens
 *                   in the lead-resolver / pii-enrich layer, NOT here.
 */

import type { CartAbandonmentMapResult } from '../shared/cart-abandonment.js';
import {
  buildFbcFromFbclid,
  extractUtmsFromUrl,
} from '../shared/cart-abandonment.js';
import type {
  OnProfitCartAbandonmentPayload,
  OnProfitStatus,
  OnProfitWebhookPayload,
} from './types.js';

// ---------------------------------------------------------------------------
// Result type (mirrors hotmart/mapper.ts for consistency)
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Internal event types produced by the OnProfit mapper
// ---------------------------------------------------------------------------

export type OnProfitInternalEventType =
  | 'Purchase'
  | 'InitiateCheckout'
  | 'RefundProcessed'
  | 'Chargeback';

/**
 * Internal event shape passed to the OnProfit ingestion processor.
 *
 * Monetary values are converted to currency UNITS (e.g. BRL float) by the
 * mapper — OnProfit sends centavos; we divide by 100 to align with the rest
 * of the pipeline (Guru already stores in unit currency).
 */
export interface OnProfitInternalEvent {
  /** Deterministic 32-char hex event_id — BR-WEBHOOK-002 */
  event_id: string;
  /** Canonical internal event type */
  event_type: OnProfitInternalEventType;
  /** Platform identifier */
  platform: 'onprofit';
  /** OnProfit order id, stringified — used as platform_event_id */
  platform_event_id: string;
  /** ISO-8601 UTC timestamp derived from confirmation_purchase_date / purchase_date */
  occurred_at: string;
  custom_data: {
    /** OnProfit order id, stringified */
    order_id: string;
    /** Amount in currency UNIT (e.g. 97.00 BRL) — NOT centavos. See note in processor. */
    amount: number;
    /** ISO 4217 currency code */
    currency: string;
    /** Payment type code (cc, pix, boleto, …) — for analytics */
    payment_type?: string | null;
    /** OnProfit's loose extra param — stored raw, not mapped to attribution */
    src?: string | null;
    /** OnProfit's loose extra param — stored raw, not mapped to attribution */
    sck?: string | null;
  };
  /**
   * Lead association hints — BR-WEBHOOK-004.
   * BR-PRIVACY-001: raw PII; processor hashes before persisting in lead_aliases.
   */
  lead_hints: {
    /** GlobalTracker lead_public_id from custom_fields — highest priority */
    lead_public_id?: string | null;
    email?: string | null;
    /** E.164 phone (customer.cell preferred) — already normalized by OnProfit */
    phone?: string | null;
    /** Full name = `${customer.name} ${customer.lastname}` */
    name?: string | null;
  };
  /** UTM attribution */
  attribution?: {
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
    utm_content?: string | null;
    utm_term?: string | null;
  } | null;
  /**
   * Meta browser cookies — propagated to events.user_data.fbc / fbp by the
   * processor when non-null. This is the primary value-add of the OnProfit
   * adapter vs Guru: Guru does not carry these cookies in its payload.
   */
  meta_cookies?: {
    fbc?: string | null;
    fbp?: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Mapping error / skip types
// ---------------------------------------------------------------------------

export type OnProfitMappingError =
  | { code: 'unknown_status'; status: string }
  | { code: 'missing_required_field'; field: string }
  | { code: 'invalid_payload'; reason: string };

export interface OnProfitSkipResult {
  ok: false;
  skip: true;
  reason: string;
}

export type OnProfitMapResult =
  | { ok: true; value: OnProfitInternalEvent }
  | OnProfitSkipResult
  | { ok: false; skip?: false; error: OnProfitMappingError };

// ---------------------------------------------------------------------------
// Idempotency key derivation
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic 32-char hex event_id.
 *
 * BR-WEBHOOK-002: event_id = sha256("onprofit:" + order.id + ":" + status)[:32]
 *
 * Including `status` in the key means a single order produces distinct
 * event_ids for its lifecycle transitions (WAITING → PAID → REFUNDED).
 * Each transition is then independently idempotent against retries.
 */
export async function deriveOnProfitEventId(
  orderId: string,
  status: string,
): Promise<string> {
  const input = `onprofit:${orderId}:${status}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Cart abandonment mapper (canonical contract: CartAbandonmentInternalEvent)
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic 32-char hex event_id for cart abandonment events.
 *
 * BR-WEBHOOK-002 / ADR-045:
 *   event_id = sha256("onprofit:cart_abandonment:" + id)[:32]
 *
 * `id` is OnProfit's internal cart ID (`payload.id`, auto-incremental integer,
 * required by schema). Auditing live data showed 100% uniqueness per cart
 * instance — OnProfit does not re-deliver the same cart, and each distinct
 * checkout attempt has a distinct id. This guarantees:
 *
 *   - Two carts from the same (lead, offer) at different times → distinct
 *     event_ids → distinct event rows (timeline reflects each visit).
 *   - Re-deliveries by OnProfit of the same cart (if they happen in the
 *     future) collapse to one event row via the `unique (workspace_id,
 *     event_id)` constraint.
 *   - Order bumps already arrive as `payload.orderbumps[]` inline within
 *     a single webhook — consolidation happens at the payload layer, not
 *     via dedup key.
 *
 * The previous formula combined `offer_hash + email`, which incorrectly
 * collapsed legitimately-distinct carts (same lead, same offer, different
 * sessions) into one event row, causing `leads.last_seen_at` to drift past
 * `MAX(events.event_time)` whenever side-effects in the raw-events-processor
 * ran before the dedup check.
 */
export async function deriveOnProfitCartAbandonmentEventId(
  id: number,
): Promise<string> {
  const input = `onprofit:cart_abandonment:${id}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Maps an OnProfit cart_abandonment webhook payload to CartAbandonmentInternalEvent.
 *
 * Structural differences handled vs order payloads:
 *   - No `status` / `price` at root → offer price from offer_details.price (centavos ÷ 100)
 *   - customer.last_name (not lastname)
 *   - UTMs embedded in `url` query string — utm.* root fields are null
 *   - No fbc/fbp cookies; fbclid extracted from `url`, fbc derived via buildFbcFromFbclid
 *
 * BR-WEBHOOK-002 / ADR-045: deterministic event_id from OnProfit `id` (unique per cart)
 * BR-WEBHOOK-004: lead_hints = email > phone (no pptc available at abandonment)
 * BR-PRIVACY-001: PII raw strings; processor hashes before persisting
 */
export async function mapOnProfitCartAbandonmentToInternal(
  payload: OnProfitCartAbandonmentPayload,
): Promise<CartAbandonmentMapResult> {
  if (!payload.customer?.email) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'customer.email' },
    };
  }

  const event_id = await deriveOnProfitCartAbandonmentEventId(payload.id);

  const occurred_at = parseOnProfitCartAbandonmentTimestamp(payload.created_at);

  // Offer price in centavos → base currency unit
  const amount =
    typeof payload.offer_details?.price === 'number'
      ? payload.offer_details.price / 100
      : null;

  // UTMs and fbclid live in the checkout URL query string, not root fields
  const urlUtms = extractUtmsFromUrl(payload.url);

  // Derive fbc from fbclid when present (no fbc cookie at abandonment)
  const fbc = urlUtms.fbclid
    ? buildFbcFromFbclid(urlUtms.fbclid, occurred_at)
    : null;

  const fullName = [payload.customer.name, payload.customer.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();

  return {
    ok: true,
    value: {
      event_id,
      event_type: 'InitiateCheckout',
      platform: 'onprofit',
      platform_event_id: String(payload.id),
      occurred_at,
      amount,
      currency: 'BRL',
      product: {
        id:
          payload.product_details?.id != null
            ? String(payload.product_details.id)
            : payload.product_id != null
              ? String(payload.product_id)
              : null,
        name: payload.product_details?.name ?? null,
        offer_id:
          payload.offer_details?.id != null
            ? String(payload.offer_details.id)
            : payload.offer_id != null
              ? String(payload.offer_id)
              : null,
        offer_name: payload.offer_details?.name ?? null,
      },
      lead_hints: {
        lead_public_id: null, // pptc not available at abandonment time
        email: payload.customer.email,
        phone: payload.customer.phone ?? null,
        name: fullName.length > 0 ? fullName : null,
      },
      attribution: {
        utm_source: urlUtms.utm_source,
        utm_medium: urlUtms.utm_medium,
        utm_campaign: urlUtms.utm_campaign,
        utm_content: urlUtms.utm_content,
        utm_term: urlUtms.utm_term,
        fbclid: urlUtms.fbclid,
      },
      meta_cookies: fbc ? { fbc, fbp: null } : null,
    },
  };
}

function parseOnProfitCartAbandonmentTimestamp(
  raw: string | null | undefined,
): string {
  if (!raw) return new Date().toISOString();
  const isoLike = raw.includes('T') ? raw : raw.replace(' ', 'T');
  // OnProfit sends naive timestamps in BRT (UTC-3) without timezone marker.
  const withTz =
    isoLike.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(isoLike)
      ? isoLike
      : `${isoLike}-03:00`;
  const d = new Date(withTz);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// ---------------------------------------------------------------------------
// Status → internal event type mapping (decided with usuário 2026-05-09)
// ---------------------------------------------------------------------------

function resolveInternalEventType(
  status: OnProfitStatus,
): OnProfitInternalEventType | 'skip' | null {
  switch (status) {
    case 'PAID':
    case 'AUTHORIZED':
      return 'Purchase';
    case 'WAITING':
      // PIX gerado / boleto emitido — buyer started checkout but did not pay yet.
      return 'InitiateCheckout';
    case 'REFUNDED':
      return 'RefundProcessed';
    case 'CHARGEBACK':
      return 'Chargeback';
    case 'STARTED':
      // Order created before payment intent — too noisy.
      return 'skip';
    case 'CANCELLED':
      // User cancelled before paying — no business value as event.
      return 'skip';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Timestamp parser
// ---------------------------------------------------------------------------

/**
 * Parses OnProfit's "YYYY-MM-DD HH:mm:ss" timestamps to ISO-8601 UTC.
 *
 * OnProfit sends naive timestamps in BRT (UTC-3) without a timezone marker.
 */
function parseOnProfitTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const isoLike = raw.includes('T') ? raw : raw.replace(' ', 'T');
  // Append BRT offset (-03:00) when no timezone marker is present.
  const withTz =
    isoLike.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(isoLike)
      ? isoLike
      : `${isoLike}-03:00`;
  const d = new Date(withTz);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Main mapper
// ---------------------------------------------------------------------------

/**
 * Maps an OnProfit webhook payload to an internal event.
 *
 * BR-WEBHOOK-002: event_id derived deterministically from order.id + status.
 * BR-WEBHOOK-003: STARTED / CANCELLED → skip; unknown status → error.
 * BR-WEBHOOK-004: lead_hints populated in priority order.
 * BR-PRIVACY-001: PII fields passed as raw strings — processor hashes.
 *
 * Currency conversion: OnProfit sends `price` in centavos.
 * We divide by 100 here so that downstream `events.custom_data.amount`
 * matches the unit-currency convention used by the Guru processor (Guru
 * already sends in BRL units). Without this division, Meta CAPI would
 * receive 100x the real conversion value.
 */
export async function mapOnProfitToInternal(
  payload: OnProfitWebhookPayload,
): Promise<OnProfitMapResult> {
  // Required fields
  if (!payload.status) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'status' },
    };
  }

  if (typeof payload.id !== 'number' || !Number.isFinite(payload.id)) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'id' },
    };
  }

  if (!payload.customer?.email) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'customer.email' },
    };
  }

  if (typeof payload.price !== 'number' || !Number.isFinite(payload.price)) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'price' },
    };
  }

  if (!payload.currency) {
    return {
      ok: false,
      error: { code: 'missing_required_field', field: 'currency' },
    };
  }

  const resolved = resolveInternalEventType(payload.status);

  // BR-WEBHOOK-003: deliberately ignored statuses
  if (resolved === 'skip') {
    return {
      ok: false,
      skip: true,
      reason: `OnProfit status '${payload.status}' is not processed (noisy / no business value)`,
    };
  }

  // BR-WEBHOOK-003: unknown status → error result (processor marks raw_event as failed)
  if (resolved === null) {
    return {
      ok: false,
      error: { code: 'unknown_status', status: String(payload.status) },
    };
  }

  const event_type = resolved;
  const orderId = String(payload.id);

  // BR-WEBHOOK-002: deterministic event_id — unique per webhook (orderId+status).
  // Both Purchase and InitiateCheckout (WAITING) fan out as N webhooks per
  // checkout (1 main + N order_bumps). Each gets its own event row; the
  // dispatcher consolidates value via transaction_group_id and skips OB
  // dispatch (BR-DISPATCH-007). Previous cart_abandonment dedup collapsed all
  // WAITINGs into one event with the first webhook's value (main only),
  // under-reporting potential checkout value to Meta/GA4.
  const event_id = await deriveOnProfitEventId(orderId, payload.status);

  // Prefer confirmation_purchase_date for PAID/AUTHORIZED; fall back to purchase_date
  // for WAITING (no confirmation yet) and as last resort to "now".
  const occurred_at =
    parseOnProfitTimestamp(payload.confirmation_purchase_date) ??
    parseOnProfitTimestamp(payload.purchase_date) ??
    new Date().toISOString();

  // OnProfit sends `price` in CENTAVOS — divide by 100 to align with the
  // unit-currency convention used by Guru (events.custom_data.amount = BRL).
  // DO NOT REMOVE THIS DIVISION — Meta CAPI would receive 100x the value
  // and inflate ROAS dashboards by two orders of magnitude.
  const amountUnit = payload.price / 100;

  // ONPROFIT-W1-TYPES (2026-05-10): `custom_fields` may be an empty array
  // (default) or an object — narrow before reading. Array form carries no
  // pptc by construction.
  const cfMapper = payload.custom_fields;
  const lead_public_id =
    cfMapper && !Array.isArray(cfMapper)
      ? (cfMapper.lead_public_id ?? null)
      : null;

  // Lead resolution priority (BR-WEBHOOK-004):
  //   1. custom_fields.lead_public_id (operator-injected pptc)
  //   2. customer.email
  //   3. customer.cell (already E.164 — preferred over .phone)
  //   4. customer.phone (display-formatted, fallback)
  // BR-PRIVACY-001: raw PII; processor hashes before any DB write.
  const phonePreferred =
    payload.customer.cell ?? payload.customer.phone ?? null;

  const fullName = [payload.customer.name, payload.customer.lastname]
    .filter((p): p is string => Boolean(p))
    .join(' ')
    .trim();

  // Attribution — present even if values are nominal ("teste" in fixtures)
  const hasAnyUtm =
    payload.utm_source ||
    payload.utm_medium ||
    payload.utm_campaign ||
    payload.utm_content ||
    payload.utm_term;

  const attribution = hasAnyUtm
    ? {
        utm_source: payload.utm_source ?? null,
        utm_medium: payload.utm_medium ?? null,
        utm_campaign: payload.utm_campaign ?? null,
        utm_content: payload.utm_content ?? null,
        utm_term: payload.utm_term ?? null,
      }
    : null;

  // Meta browser cookies — the headline value of OnProfit vs Guru.
  // Guru does not carry these; OnProfit captures them at checkout and forwards.
  // We propagate when non-null so the Meta CAPI dispatcher receives high-quality
  // browser-side identifiers (massive match-quality lift).
  const meta_cookies =
    payload.fbc || payload.fbp
      ? {
          fbc: payload.fbc ?? null,
          fbp: payload.fbp ?? null,
        }
      : null;

  const event: OnProfitInternalEvent = {
    event_id,
    event_type,
    platform: 'onprofit',
    platform_event_id: orderId,
    occurred_at,
    custom_data: {
      order_id: orderId,
      amount: amountUnit,
      currency: payload.currency,
      payment_type: payload.payment_type ?? null,
      // src / sck are loosely-typed extra params with no documented contract.
      // Stored raw (not mapped to attribution.*) so we don't fabricate semantics.
      src: payload.src ?? null,
      sck: payload.sck ?? null,
    },
    // BR-WEBHOOK-004 / BR-PRIVACY-001
    lead_hints: {
      lead_public_id,
      email: payload.customer.email,
      phone: phonePreferred,
      name: fullName.length > 0 ? fullName : null,
    },
    attribution,
    meta_cookies,
  };

  return { ok: true, value: event };
}
