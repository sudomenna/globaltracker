/**
 * cart-abandonment.ts — Canonical contract for cart abandonment events.
 *
 * Every payment provider's cart abandonment mapper MUST produce
 * CartAbandonmentInternalEvent. The processor handles this type identically
 * regardless of source platform.
 *
 * Why a shared type: cart abandonment payloads differ structurally from order
 * webhooks in every provider (different field names, no `status`, offer price
 * vs confirmed amount, UTMs often embedded in URL). A shared output contract
 * lets new providers plug in without touching the processor.
 *
 * BRs:
 *   BR-WEBHOOK-002: event_id must be deterministic (sha256) — each provider impl
 *   BR-WEBHOOK-004: lead_hints priority = lead_public_id > email > phone
 *   BR-PRIVACY-001: PII fields are raw strings; processor hashes before persisting
 */

// ---------------------------------------------------------------------------
// Canonical event type
// ---------------------------------------------------------------------------

export interface CartAbandonmentInternalEvent {
  /** Deterministic 32-char hex — BR-WEBHOOK-002 */
  event_id: string;
  /** Always InitiateCheckout for cart abandonment */
  event_type: 'InitiateCheckout';
  /** Originating platform (e.g. 'onprofit', 'guru', 'hotmart') */
  platform: string;
  /** Provider's native ID for this abandonment record */
  platform_event_id: string;
  /** ISO-8601 UTC — when the abandonment was detected */
  occurred_at: string;
  /**
   * Intended purchase value (offer price — NOT a confirmed payment).
   * In base currency unit, NOT centavos. Provider mappers must divide by 100
   * when the provider sends centavos.
   */
  amount?: number | null;
  /** ISO 4217 currency code */
  currency?: string | null;

  product?: {
    id?: string | null;
    name?: string | null;
    offer_id?: string | null;
    offer_name?: string | null;
  } | null;

  /**
   * Lead resolution hints — BR-WEBHOOK-004.
   * Processor resolves in priority order; PII hashed before persisting.
   * BR-PRIVACY-001: raw strings — never log.
   */
  lead_hints: {
    lead_public_id?: string | null;
    email?: string | null;
    phone?: string | null;
    /** Display name for fn/ln hash enrichment */
    name?: string | null;
  };

  attribution?: {
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_campaign?: string | null;
    utm_content?: string | null;
    utm_term?: string | null;
    /**
     * fbclid from checkout URL — available at abandonment even when the fbc
     * cookie is absent. Processors derive fbc = "fb.1.{ts_ms}.{fbclid}".
     */
    fbclid?: string | null;
  } | null;

  /**
   * Meta browser cookies — propagated to events.user_data.fbc/fbp.
   * Not all providers carry these at abandonment time; null is valid.
   */
  meta_cookies?: {
    fbc?: string | null;
    fbp?: string | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Result / error types (mirror provider mapper conventions)
// ---------------------------------------------------------------------------

export type CartAbandonmentMappingError =
  | { code: 'missing_required_field'; field: string }
  | { code: 'invalid_payload'; reason: string };

export type CartAbandonmentMapResult =
  | { ok: true; value: CartAbandonmentInternalEvent }
  | { ok: false; skip: true; reason: string }
  | { ok: false; skip?: false; error: CartAbandonmentMappingError };

// ---------------------------------------------------------------------------
// Shared helpers (used by multiple providers)
// ---------------------------------------------------------------------------

/**
 * Extracts UTM parameters and fbclid from a URL query string.
 *
 * Used by providers that embed attribution in the checkout URL rather than
 * as top-level payload fields (e.g. OnProfit cart_abandonment sends
 * utm.source=null at root but carries ?utm_source=meta in the `url` field).
 */
export function extractUtmsFromUrl(url: string | null | undefined): {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  fbclid: string | null;
} {
  const empty = {
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    fbclid: null,
  };
  if (!url) return empty;
  try {
    const u = new URL(url);
    return {
      utm_source: u.searchParams.get('utm_source'),
      utm_medium: u.searchParams.get('utm_medium'),
      utm_campaign: u.searchParams.get('utm_campaign'),
      utm_content: u.searchParams.get('utm_content'),
      utm_term: u.searchParams.get('utm_term'),
      fbclid: u.searchParams.get('fbclid'),
    };
  } catch {
    return empty;
  }
}

/**
 * Derives an fbc cookie value from a raw fbclid.
 *
 * Format: fb.1.{unix_ms}.{fbclid}
 * Used when the fbc cookie is absent at abandonment time but fbclid is
 * available in the checkout URL (e.g. OnProfit cart_abandonment).
 */
export function buildFbcFromFbclid(fbclid: string, occurredAt: string): string {
  const ts = new Date(occurredAt).getTime();
  return `fb.1.${ts}.${fbclid}`;
}
