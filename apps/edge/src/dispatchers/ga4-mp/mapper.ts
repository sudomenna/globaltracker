/**
 * GA4 Measurement Protocol mapper — pure function, no I/O.
 *
 * Maps an internal event + lead row to a GA4 Measurement Protocol payload.
 *
 * T-4-004
 * BR-DISPATCH-001: idempotency_key uses measurement_id as destination_subresource (ADR-013)
 * BR-CONSENT-003: consent object forwarded to GA4 for ad signal configuration
 * docs/40-integrations/00-event-name-mapping.md: internal names translated to GA4 names
 */

import { resolveClientId } from './client-id-resolver.js';
import type { ClientIdUserData } from './client-id-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Consent value per finality (BR-CONSENT-001). */
type ConsentValue = 'granted' | 'denied' | 'unknown';

/** Consent snapshot embedded in event rows (BR-CONSENT-002). */
export interface ConsentSnapshot {
  analytics?: ConsentValue;
  marketing?: ConsentValue;
  ad_user_data?: ConsentValue;
  ad_personalization?: ConsentValue;
  customer_match?: ConsentValue;
}

/** Minimal shape of an event row as consumed by this dispatcher. */
export interface Ga4DispatchableEvent {
  event_id: string;
  event_name: string;
  /** Unix timestamp in seconds OR ISO string OR Date. */
  event_time: number | string | Date;
  lead_id?: string | null;
  workspace_id: string;
  user_data?:
    | (ClientIdUserData & {
        session_id_ga4?: string | null;
      })
    | null;
  custom_data?: Record<string, unknown> | null;
  consent_snapshot?: ConsentSnapshot | null;
}

/** Minimal shape of a lead row as consumed by this dispatcher. */
export interface Ga4DispatchableLead {
  /** Public-facing lead identifier — safe to use as GA4 user_id. */
  public_id?: string | null;
  /** SHA-256 of external identifier (e.g. Hotmart subscriber_code). */
  external_id_hash?: string | null;
}

/** Context passed to the mapper. */
export interface Ga4MapperContext {
  /** Enable GA4 debug mode (Validation API). */
  debugMode?: boolean;
}

// ---------------------------------------------------------------------------
// GA4 payload types
// ---------------------------------------------------------------------------

/** GA4 consent signal (forwarded from event consent_snapshot). */
export interface Ga4ConsentSignal {
  /** Consent for using event data for advertising. */
  ad_user_data?: ConsentValue;
  /** Consent for personalizing ads. */
  ad_personalization?: ConsentValue;
}

/** GA4 event params for a single event. */
export interface Ga4EventParams {
  /** Monetary value (Purchase, generate_lead). */
  value?: number;
  /** ISO 4217 currency code. */
  currency?: string;
  /** Order/transaction ID for Purchase — maps to transaction_id in GA4. */
  transaction_id?: string;
  /** Group identifier for join_group event — comes from custom_data.group_id (e.g. SendFlow campaign_id). */
  group_id?: string;
  /** GA4 session identifier (from gtag session). */
  session_id?: string;
  /** Engagement time in milliseconds (recommended for all events). */
  engagement_time_msec?: number;
  /**
   * Items array — required for GA4 Purchase audiences (remarketing, purchase audiences).
   * T-14-013: populated only for Purchase events when product_id or product_name present.
   */
  items?: Array<{
    item_id?: string;
    item_name?: string;
    price?: number;
    quantity: number;
  }>;
  [key: string]: unknown;
}

/** Single GA4 event in the payload. */
export interface Ga4Event {
  /** GA4 recommended/custom event name (snake_case). */
  name: string;
  params?: Ga4EventParams;
}

/** Full GA4 Measurement Protocol payload. */
export interface Ga4MpPayload {
  /** GA4 browser client_id. Required. */
  client_id: string;
  /** GA4 user_id (derived from lead.public_id or lead.external_id_hash). */
  user_id?: string;
  /** Unix timestamp in microseconds (event_time × 1_000_000). */
  timestamp_micros: number;
  /** List of events to send (GA4 MP accepts up to 25; we send 1 per dispatch). */
  events: Ga4Event[];
  /** Consent signals forwarded from event consent_snapshot. */
  consent?: Ga4ConsentSignal;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Canonical mapping: internal event_name → GA4 Measurement Protocol event name.
 *
 * Reference: docs/40-integrations/00-event-name-mapping.md
 *
 * Events without a GA4 equivalent return null — dispatcher creates a
 * dispatch_job with status='skipped' and skip_reason='no_ga4_equivalent'.
 * Never pass internal names directly to GA4 (e.g. 'Subscribe') — breaks reports.
 */
const INTERNAL_TO_GA4_EVENT_NAME: Record<string, string | null> = {
  PageView: 'page_view',
  Lead: 'generate_lead',
  Contact: 'generate_lead',
  ViewContent: 'view_item',
  InitiateCheckout: 'begin_checkout',
  AddToCart: 'add_to_cart',
  AddToWishlist: 'add_to_wishlist',
  AddPaymentInfo: 'add_payment_info',
  CompleteRegistration: 'sign_up',
  Search: 'search',
  Purchase: 'purchase',
  SubmitApplication: 'generate_lead',
  // Events with no GA4 standard equivalent — must return null.
  Subscribe: null,
  StartTrial: null,
  Schedule: null,
  Donate: null,
  FindLocation: null,
  CustomizeProduct: null,
  // Custom events mapped to GA4 standard recommended events.
  // join_group: GA4 recommended event for "user joins a group" — fits WhatsApp/Telegram/etc.
  'custom:click_wpp_join': 'join_group',
  'custom:wpp_joined': 'join_group',
  'custom:wpp_joined_vip_main': 'join_group',
  // custom:click_buy_* removed — INTERNAL_ONLY events; begin_checkout comes from server-side webhooks.
  'custom:watched_workshop': 'view_item',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maps an internal event + optional lead row to a GA4 Measurement Protocol payload.
 *
 * Pure function — no I/O, no side effects, fully testable.
 *
 * Returns null when the internal event_name has no GA4 equivalent.
 * Caller MUST treat null as skip with skip_reason='no_ga4_equivalent'.
 *
 * T-4-004
 * BR-DISPATCH-001: idempotency_key derivation handled by caller using measurement_id
 *   as destination_subresource (ADR-013).
 * BR-CONSENT-003: consent signals forwarded so GA4 can apply data governance rules.
 *
 * @param event - internal event row (or subset)
 * @param lead  - lead row for user_id enrichment; null/undefined when unavailable
 * @param ctx   - optional mapper context
 * @returns Ga4MpPayload or null (no GA4 equivalent for this event_name)
 */
export function mapEventToGa4Payload(
  event: Ga4DispatchableEvent,
  lead: Ga4DispatchableLead | null | undefined,
  ctx?: Ga4MapperContext,
): Ga4MpPayload | null {
  // Translate internal event_name to GA4 name.
  // docs/40-integrations/00-event-name-mapping.md: null = no GA4 equivalent.
  const ga4EventName = resolveGa4EventName(event.event_name);
  if (ga4EventName === null) {
    // Return null → caller sets skip_reason='no_ga4_equivalent'
    return null;
  }

  // Resolve client_id (required for GA4 MP).
  // OQ-003 CLOSED: minting strategy from fvid when _ga cookie absent.
  const clientId = resolveClientId(event.user_data);

  // client_id is REQUIRED — but we return a placeholder here so the mapper
  // stays pure. Eligibility check (checkEligibility) guards against null
  // client_id BEFORE this mapper is called in production.
  // In the rare case this is called without eligibility guard, we use an
  // empty string — GA4 will reject it, classifyError will handle.
  const resolvedClientId = clientId ?? '';

  // Convert event_time to microseconds (GA4 MP requires timestamp_micros).
  const timestampMicros = toMicros(event.event_time);

  // Build user_id from lead (prefer public_id as it is non-sensitive).
  const userId = resolveUserId(lead);

  // Build event params.
  const params = buildEventParams(event);

  // Build GA4 consent signal from consent_snapshot.
  // BR-CONSENT-003: consent signals forwarded for GA4 data governance.
  const consent = buildConsentSignal(event.consent_snapshot);

  const payload: Ga4MpPayload = {
    client_id: resolvedClientId,
    timestamp_micros: timestampMicros,
    events: [
      {
        name: ga4EventName,
        ...(Object.keys(params).length > 0 ? { params } : {}),
      },
    ],
  };

  if (userId !== null) {
    payload.user_id = userId;
  }

  if (consent !== null) {
    payload.consent = consent;
  }

  // ctx is accepted for future use (debug mode surface) but not applied here;
  // debug mode is handled at the client layer via URL parameter.
  void ctx;

  return payload;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the GA4 event name for a given internal event_name.
 *
 * Returns null for internal events without a GA4 standard equivalent.
 * Unknown event names (not in the mapping table) are passed through
 * as-is (custom events) per docs/40-integrations/00-event-name-mapping.md §Regra.
 */
function resolveGa4EventName(internalName: string): string | null {
  if (
    Object.prototype.hasOwnProperty.call(
      INTERNAL_TO_GA4_EVENT_NAME,
      internalName,
    )
  ) {
    return INTERNAL_TO_GA4_EVENT_NAME[internalName] ?? null;
  }
  // Unknown internal name → pass as custom event name (not in the no-equivalent list)
  return internalName;
}

/**
 * Converts event_time to Unix microseconds for GA4 timestamp_micros.
 */
function toMicros(eventTime: number | string | Date): number {
  if (typeof eventTime === 'number') {
    // Assume Unix seconds if plausible (< 1e12); otherwise micros already.
    return eventTime < 1e12 ? eventTime * 1_000_000 : eventTime;
  }
  if (eventTime instanceof Date) {
    return Math.floor(eventTime.getTime() / 1000) * 1_000_000;
  }
  // ISO string
  return Math.floor(new Date(eventTime).getTime() / 1000) * 1_000_000;
}

/**
 * Derives the GA4 user_id from the lead row.
 * Prefers public_id (non-sensitive); falls back to external_id_hash.
 */
function resolveUserId(
  lead: Ga4DispatchableLead | null | undefined,
): string | null {
  if (!lead) return null;
  if (lead.public_id) return lead.public_id;
  if (lead.external_id_hash) return lead.external_id_hash;
  return null;
}

/**
 * Builds GA4 event params from event custom_data and user_data.
 *
 * T-14-013 — four enhancements:
 *   1. value reads cd.value ?? cd.amount (Guru events use amount, not value).
 *   2. items array populated for Purchase when product_id or product_name present.
 *   3. transaction_id falls back to event.event_id for Purchase when order_id absent.
 *   4. Lead events also pick up amount as value (same cd.value ?? cd.amount path).
 */
function buildEventParams(event: Ga4DispatchableEvent): Ga4EventParams {
  const params: Ga4EventParams = {};
  const cd = event.custom_data ?? {};

  // value: prefer cd.value; fall back to cd.amount (Guru webhook shape uses amount).
  const rawValue =
    typeof cd.value === 'number'
      ? cd.value
      : typeof cd.amount === 'number'
        ? cd.amount
        : undefined;

  if (rawValue !== undefined) {
    params.value = rawValue;
  }

  if (typeof cd.currency === 'string') {
    params.currency = cd.currency;
  }

  // transaction_id: order_id takes precedence; for Purchase, fall back to event_id.
  if (event.event_name === 'Purchase') {
    params.transaction_id =
      typeof cd.order_id === 'string' ? cd.order_id : event.event_id;
  } else if (typeof cd.order_id === 'string') {
    params.transaction_id = cd.order_id;
  }

  // items: only for Purchase, only when at least item_id or item_name is available.
  // Required by GA4 for purchase audience membership (remarketing, purchase audiences).
  if (event.event_name === 'Purchase') {
    const itemId =
      typeof cd.product_id === 'string' ? cd.product_id : undefined;
    const itemName =
      typeof cd.product_name === 'string' ? cd.product_name : undefined;

    if (itemId !== undefined || itemName !== undefined) {
      params.items = [
        {
          ...(itemId !== undefined && { item_id: itemId }),
          ...(itemName !== undefined && { item_name: itemName }),
          ...(rawValue !== undefined && { price: rawValue }),
          quantity: 1,
        },
      ];
    }
  }

  // session_id from user_data.session_id_ga4
  if (event.user_data?.session_id_ga4) {
    params.session_id = event.user_data.session_id_ga4;
  }

  // group_id: required parameter for GA4 `join_group` event.
  // Source priority: cd.group_id > cd.campaign_id (SendFlow stores campaign_id in custom_data).
  if (typeof cd.group_id === 'string') {
    params.group_id = cd.group_id;
  } else if (typeof cd.campaign_id === 'string') {
    params.group_id = cd.campaign_id;
  }

  return params;
}

/**
 * Builds the GA4 consent signal object from event consent_snapshot.
 * Returns null when consent_snapshot is absent.
 *
 * BR-CONSENT-003: consent forwarded to GA4 for proper data governance.
 */
function buildConsentSignal(
  snapshot: ConsentSnapshot | null | undefined,
): Ga4ConsentSignal | null {
  if (!snapshot) return null;

  const consent: Ga4ConsentSignal = {};
  let hasFields = false;

  if (snapshot.ad_user_data !== undefined) {
    consent.ad_user_data = snapshot.ad_user_data;
    hasFields = true;
  }
  if (snapshot.ad_personalization !== undefined) {
    consent.ad_personalization = snapshot.ad_personalization;
    hasFields = true;
  }

  return hasFields ? consent : null;
}
