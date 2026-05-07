/**
 * Meta CAPI mapper — pure function, no I/O.
 *
 * Maps an internal event + lead row to a Meta Conversions API payload.
 *
 * T-3-001
 * BR-DISPATCH-001: event_id is carried through as-is for Meta dedup
 * BR-CONSENT-003: PII fields (em, ph) only present when lead lookup succeeded
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of an event row as consumed by this dispatcher. */
export interface DispatchableEvent {
  event_id: string;
  event_name: string;
  event_time: Date | string;
  lead_id?: string | null;
  workspace_id: string;
  /** Anonymous visitor ID (cookie __fvid, UUID v4). Maps to Meta external_id. */
  visitor_id?: string | null;
  user_data?: {
    fbc?: string | null;
    fbp?: string | null;
    client_ip_address?: string | null;
    client_user_agent?: string | null;
  } | null;
  custom_data?: Record<string, unknown> | null;
}

/** Minimal shape of a lead row as consumed by this dispatcher. */
export interface DispatchableLead {
  /** SHA-256 hex puro de email normalizado — para Meta CAPI em. */
  email_hash_external?: string | null;
  /** SHA-256 hex puro de phone E.164 — para Meta CAPI ph. */
  phone_hash_external?: string | null;
  /** SHA-256 hex puro do first name lowercase — para Meta CAPI fn. */
  fn_hash?: string | null;
  /** SHA-256 hex puro do last name lowercase — para Meta CAPI ln. */
  ln_hash?: string | null;
}

/** Context passed to the mapper (env vars, etc.) */
export interface MapperContext {
  /** Optional test event code for Meta's Test Event Tool. */
  testEventCode?: string;
}

// ---------------------------------------------------------------------------
// Meta CAPI payload types
// ---------------------------------------------------------------------------

/** Meta user_data object — only fields relevant to server-side dispatch. */
export interface MetaUserData {
  /** SHA-256 hex de email normalizado. Meta: em. */
  em?: string;
  /** SHA-256 hex de phone E.164. Meta: ph. */
  ph?: string;
  /** SHA-256 hex de first name lowercase. Meta: fn. */
  fn?: string;
  /** SHA-256 hex de last name lowercase. Meta: ln. */
  ln?: string;
  /** Visitor ID anônimo (cookie __fvid, UUID v4). Meta: external_id.
   *  PLANO — Meta hashea internamente. */
  external_id?: string;
  /** Facebook click ID cookie value. Not hashed. */
  fbc?: string;
  /** Facebook browser ID cookie value. Not hashed. */
  fbp?: string;
  /** Client IP address (transient, not persisted). Not hashed. */
  client_ip_address?: string;
  /** Client user agent string (transient, not persisted). Not hashed. */
  client_user_agent?: string;
}

/** Meta custom_data object for monetised events (Purchase, etc.) */
export interface MetaCustomData {
  value?: number;
  currency?: string;
  order_id?: string;
  [key: string]: unknown;
}

/** Single event payload in a Meta CAPI request. */
export interface MetaCapiPayload {
  /** Meta standard event name (PascalCase). */
  event_name: string;
  /** Unix timestamp in seconds. */
  event_time: number;
  /** Action source — always "website" for server-side dispatches. */
  action_source: 'website';
  /** Globally unique event ID — matches browser Pixel eventID for dedup. */
  event_id: string;
  user_data: MetaUserData;
  custom_data?: MetaCustomData;
  /** Optional — only present in dev/test with META_CAPI_TEST_EVENT_CODE. */
  test_event_code?: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Canonical mapping: internal event_name → Meta standard event name.
 *
 * Meta uses PascalCase. Internal names are already PascalCase-aligned
 * to Meta's convention, so most pass through 1:1.
 * Reference: docs/40-integrations/00-event-name-mapping.md
 */
const INTERNAL_TO_META_EVENT_NAME: Record<string, string> = {
  PageView: 'PageView',
  Lead: 'Lead',
  Contact: 'Contact',
  ViewContent: 'ViewContent',
  InitiateCheckout: 'InitiateCheckout',
  AddToCart: 'AddToCart',
  AddToWishlist: 'AddToWishlist',
  AddPaymentInfo: 'AddPaymentInfo',
  CompleteRegistration: 'CompleteRegistration',
  Search: 'Search',
  Purchase: 'Purchase',
  Subscribe: 'Subscribe',
  StartTrial: 'StartTrial',
  Schedule: 'Schedule',
  Donate: 'Donate',
  FindLocation: 'FindLocation',
  SubmitApplication: 'SubmitApplication',
  CustomizeProduct: 'CustomizeProduct',
  // Custom events mapped to Meta standard events for cross-channel dedup.
  // Both Pixel (browser) and CAPI (server) must send the same Meta event_name
  // for Meta's deduplication algorithm to recognize them as the same event.
  'custom:click_wpp_join': 'Contact',
  'custom:click_buy_workshop': 'InitiateCheckout',
  'custom:click_buy_main': 'InitiateCheckout',
  'custom:watched_workshop': 'ViewContent',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maps an internal event + optional lead row to a Meta CAPI single-event payload.
 *
 * Pure function — no I/O, no side effects, fully testable.
 *
 * T-3-001
 * BR-DISPATCH-001: event_id is preserved verbatim for cross-channel dedup.
 * BR-CONSENT-003: em/ph are only included when lead is provided and hashes exist.
 *
 * @param event - internal event row (or subset of it)
 * @param lead  - lead row for enrichment; null/undefined when not available
 *               (e.g. PageView before identity resolution)
 * @param ctx   - optional context (env vars, test event code)
 */
export function mapEventToMetaPayload(
  event: DispatchableEvent,
  lead: DispatchableLead | null | undefined,
  ctx?: MapperContext,
): MetaCapiPayload {
  // BR-DISPATCH-001: translate internal event_name to Meta canonical name.
  // Unknown names pass through as-is (Meta accepts custom event names).
  const metaEventName =
    INTERNAL_TO_META_EVENT_NAME[event.event_name] ?? event.event_name;

  // Convert event_time to Unix seconds.
  const eventTimeUnix =
    typeof event.event_time === 'string'
      ? Math.floor(new Date(event.event_time).getTime() / 1000)
      : Math.floor((event.event_time as Date).getTime() / 1000);

  // Build user_data.
  // BR-CONSENT-003: em and ph only from lead lookup; do NOT re-hash — already SHA-256 hex.
  const userData: MetaUserData = {};

  // BR-CONSENT-003: usar hashes externos (SHA-256 puro) — NÃO re-hashear
  if (lead?.email_hash_external) {
    userData.em = lead.email_hash_external;
  }
  if (lead?.phone_hash_external) {
    userData.ph = lead.phone_hash_external;
  }
  if (lead?.fn_hash) {
    userData.fn = lead.fn_hash;
  }
  if (lead?.ln_hash) {
    userData.ln = lead.ln_hash;
  }
  // Visitor ID — external_id em PLANO (Meta hashea internamente).
  // BR-CONSENT-003: external_id é anônimo (UUID v4 random), não-PII;
  // passa sem consent específico junto com fbc/fbp.
  if (event.visitor_id) {
    userData.external_id = event.visitor_id;
  }
  if (event.user_data?.fbc) {
    userData.fbc = event.user_data.fbc;
  }
  if (event.user_data?.fbp) {
    userData.fbp = event.user_data.fbp;
  }
  // client_ip_address and client_user_agent are transient — not hashed per spec.
  if (event.user_data?.client_ip_address) {
    userData.client_ip_address = event.user_data.client_ip_address;
  }
  if (event.user_data?.client_user_agent) {
    userData.client_user_agent = event.user_data.client_user_agent;
  }

  // Build custom_data for monetised events (Purchase, etc.)
  const customData = buildCustomData(event);

  const payload: MetaCapiPayload = {
    event_name: metaEventName,
    event_time: eventTimeUnix,
    action_source: 'website',
    event_id: event.event_id,
    user_data: userData,
  };

  if (customData !== null) {
    payload.custom_data = customData;
  }

  // Append test_event_code when running in dev/test mode.
  if (ctx?.testEventCode) {
    payload.test_event_code = ctx.testEventCode;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extracts custom_data for Purchase and other monetised events.
 * Returns null when no relevant custom_data fields are present.
 */
function buildCustomData(event: DispatchableEvent): MetaCustomData | null {
  if (!event.custom_data) return null;

  const cd = event.custom_data;
  const result: MetaCustomData = {};
  let hasFields = false;

  // Accept both `value` (canonical) and `amount` (Guru processor convention).
  const numericValue =
    typeof cd.value === 'number'
      ? cd.value
      : typeof cd.amount === 'number'
        ? cd.amount
        : null;
  if (numericValue !== null) {
    result.value = numericValue;
    hasFields = true;
  }
  if (typeof cd.currency === 'string') {
    result.currency = cd.currency;
    hasFields = true;
  }
  // Accept `order_id` (canonical) or fallback to `product_id` (Guru convention).
  const orderId =
    typeof cd.order_id === 'string'
      ? cd.order_id
      : typeof cd.product_id === 'string'
        ? cd.product_id
        : null;
  if (orderId !== null) {
    result.order_id = orderId;
    hasFields = true;
  }

  return hasFields ? result : null;
}
