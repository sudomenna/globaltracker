/**
 * types.ts — TypeScript types for Stripe webhook payloads.
 *
 * T-ID: T-9-003
 * Spec: docs/40-integrations/09-stripe-webhook.md
 *
 * BR-PRIVACY-001: Fields containing PII (customer_email, customer_details.email,
 * customer_details.name, customer_details.phone, billing_details.email,
 * billing_details.name, billing_details.phone, receipt_email) are present here
 * as raw strings. The lead-resolver / ingestion processor is responsible for
 * hashing before persisting into lead_aliases. Never log these fields.
 */

// ---------------------------------------------------------------------------
// Stripe Event envelope
// ---------------------------------------------------------------------------

export interface StripeEvent {
  /** Globally unique event ID — evt_xxx */
  id: string;
  object: 'event';
  type: string;
  /** Unix epoch seconds */
  created: number;
  data: {
    object:
      | StripeCheckoutSession
      | StripePaymentIntent
      | StripeCharge
      | Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Stripe Checkout Session (checkout.session.completed)
// ---------------------------------------------------------------------------

export interface StripeCheckoutSession {
  id: string;
  object: 'checkout.session';
  /** Amount in cents */
  amount_total?: number | null;
  currency?: string | null;
  /** BR-PRIVACY-001: PII — do not log */
  customer_email?: string | null;
  /** BR-PRIVACY-001: PII — do not log */
  customer_details?: {
    email?: string | null;
    phone?: string | null;
    name?: string | null;
  } | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string | null>;
  payment_intent?: string | null;
}

// ---------------------------------------------------------------------------
// Stripe Payment Intent (payment_intent.succeeded)
// ---------------------------------------------------------------------------

export interface StripePaymentIntent {
  id: string;
  object: 'payment_intent';
  /** Amount in cents */
  amount: number;
  currency: string;
  /** BR-PRIVACY-001: PII — do not log */
  receipt_email?: string | null;
  metadata?: Record<string, string | null>;
}

// ---------------------------------------------------------------------------
// Stripe Charge (charge.refunded)
// ---------------------------------------------------------------------------

export interface StripeCharge {
  id: string;
  object: 'charge';
  /** Amount refunded in cents */
  amount_refunded: number;
  currency: string;
  /** BR-PRIVACY-001: PII — do not log */
  billing_details?: {
    email?: string | null;
    phone?: string | null;
    name?: string | null;
  } | null;
  metadata?: Record<string, string | null>;
}

// ---------------------------------------------------------------------------
// Type guard helpers
// ---------------------------------------------------------------------------

export function isStripeCheckoutSession(
  obj: unknown,
): obj is StripeCheckoutSession {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>)['object'] === 'checkout.session'
  );
}

export function isStripePaymentIntent(
  obj: unknown,
): obj is StripePaymentIntent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>)['object'] === 'payment_intent'
  );
}

export function isStripeCharge(obj: unknown): obj is StripeCharge {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>)['object'] === 'charge'
  );
}
