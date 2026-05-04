/**
 * types.ts — TypeScript types for Kiwify webhook payloads.
 *
 * Derived from docs/40-integrations/08-kiwify-webhook.md
 * and the official Kiwify webhook documentation.
 *
 * BR-PRIVACY-001: Fields containing PII (customer.email, customer.phone,
 * customer.mobile, customer.name) are present here as raw strings.
 * The lead-resolver / ingestion processor is responsible for hashing before
 * persisting into lead_aliases. Never log these fields.
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Known Kiwify webhook event types. */
export type KiwifyEventType =
  | 'order.paid'
  | 'order.refunded'
  | 'order.created'
  | 'subscription.canceled'
  | (string & NonNullable<unknown>); // allow unknown types for graceful handling

// ---------------------------------------------------------------------------
// Payload shape
// ---------------------------------------------------------------------------

export interface KiwifyOrderTracking {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
}

export interface KiwifyOrder {
  /** Platform order ID — used as platform_event_id and for idempotency key */
  id: string;
  status: string;
  /** Order total in cents (e.g. 29700 = R$297.00) */
  total_value_cents: number;
  /** ISO 4217 currency code (e.g. 'BRL') */
  currency: string;
  /**
   * Optional buyer reference. If it starts with 'ldr_' it is treated as
   * a lead_public_id per BR-WEBHOOK-004.
   */
  client_ref?: string | null;
  tracking?: KiwifyOrderTracking | null;
}

export interface KiwifyCustomer {
  /** BR-PRIVACY-001: PII — do not log */
  name: string;
  /** BR-PRIVACY-001: PII — do not log */
  email: string;
  /** BR-PRIVACY-001: PII — do not log */
  phone?: string | null;
  /** BR-PRIVACY-001: PII — do not log (alternative phone field) */
  mobile?: string | null;
}

export interface KiwifyProduct {
  id: string;
  name: string;
}

export interface KiwifySubscription {
  id: string;
  status: string;
}

export interface KiwifyMetadata {
  /**
   * GlobalTracker lead_public_id, if decorated by the checkout embed.
   * Highest-priority lead association hint (BR-WEBHOOK-004, priority 1).
   */
  lead_public_id?: string | null;
}

export interface KiwifyWebhookPayload {
  /** Discriminator for mapping — e.g. 'order.paid', 'order.refunded', 'order.created', 'subscription.canceled' */
  event_type: KiwifyEventType;
  order?: KiwifyOrder | null;
  customer?: KiwifyCustomer | null;
  product?: KiwifyProduct | null;
  subscription?: KiwifySubscription | null;
  metadata?: KiwifyMetadata | null;
}
