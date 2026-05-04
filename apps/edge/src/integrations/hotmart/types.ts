/**
 * types.ts — TypeScript types for Hotmart webhook payloads.
 *
 * Derived from docs/40-integrations/07-hotmart-webhook.md
 * and the official Hotmart webhook documentation.
 *
 * BR-PRIVACY-001: Fields containing PII (buyer.email, buyer.name,
 * buyer.checkout_phone) are present here as raw strings.
 * The lead-resolver / ingestion processor is responsible for hashing before
 * persisting into lead_aliases. Never log these fields.
 */

// ---------------------------------------------------------------------------
// Hotmart event types (inbound)
// ---------------------------------------------------------------------------

export type HotmartEventType =
  | 'PURCHASE_APPROVED'
  | 'PURCHASE_REFUNDED'
  | 'PURCHASE_CHARGEBACK'
  | 'PURCHASE_PROTEST'
  | 'PURCHASE_BILLET_PRINTED'
  | 'SUBSCRIPTION_CANCELLATION'
  | (string & NonNullable<unknown>); // allow unknown events for graceful handling

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

export interface HotmartPrice {
  /** Amount in centavos (e.g. 29700 = BRL 297.00) */
  value: number;
  /** ISO 4217 currency code (e.g. 'BRL') */
  currency_value: string;
}

// ---------------------------------------------------------------------------
// Tracking / UTMs
// ---------------------------------------------------------------------------

export interface HotmartTracking {
  source?: string | null;
  source_sck?: string | null;
  external_reference?: string | null;
}

export interface HotmartUtms {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
}

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

export interface HotmartPurchase {
  /** Unique transaction code — used as platform_event_id */
  transaction: string;
  status: string;
  price: HotmartPrice;
  tracking?: HotmartTracking | null;
  utms?: HotmartUtms | null;
}

// ---------------------------------------------------------------------------
// Buyer
// ---------------------------------------------------------------------------

export interface HotmartBuyer {
  /** BR-PRIVACY-001: PII — do not log */
  name: string;
  /** BR-PRIVACY-001: PII — do not log */
  email: string;
  /** BR-PRIVACY-001: PII — do not log */
  checkout_phone?: string | null;
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export interface HotmartProduct {
  id: number;
  name: string;
}

// ---------------------------------------------------------------------------
// Data envelope
// ---------------------------------------------------------------------------

export interface HotmartWebhookData {
  purchase: HotmartPurchase;
  buyer: HotmartBuyer;
  product?: HotmartProduct | null;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export interface HotmartWebhookMetadata {
  /**
   * GlobalTracker lead_public_id — highest-priority hint for lead association.
   * BR-WEBHOOK-004: passed via Hotmart pass-through from checkout link.
   */
  lead_public_id?: string | null;
}

// ---------------------------------------------------------------------------
// Root payload
// ---------------------------------------------------------------------------

export interface HotmartWebhookPayload {
  /** Hotmart event type (e.g. 'PURCHASE_APPROVED') */
  event: HotmartEventType;
  /** Hotmart-generated event UUID */
  id: string;
  /** Creation timestamp in epoch milliseconds */
  creation_date: number;
  /** API version string */
  version: string;
  data: HotmartWebhookData;
  metadata?: HotmartWebhookMetadata | null;
}
