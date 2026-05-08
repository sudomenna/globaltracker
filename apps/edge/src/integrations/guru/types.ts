/**
 * types.ts — TypeScript types for Digital Manager Guru webhook payloads.
 *
 * Derived from docs/40-integrations/13-digitalmanager-guru-webhook.md
 * and the official Guru webhook documentation.
 *
 * BR-PRIVACY-001: Fields containing PII (contact.email, contact.phone_number,
 * contact.doc, subscriber.email, subscriber.doc) are present here as raw strings.
 * The lead-resolver / ingestion processor is responsible for hashing before
 * persisting into lead_aliases. Never log these fields.
 */

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export type GuruWebhookType = 'transaction' | 'subscription' | 'eticket';

/** Transaction statuses that we handle or skip. */
export type GuruTransactionStatus =
  | 'approved'
  | 'refunded'
  | 'chargedback'
  | 'canceled'
  | 'abandoned'
  | 'waiting_payment'
  | 'expired'
  | (string & NonNullable<unknown>); // allow unknown statuses for graceful handling

/** Subscription statuses that we handle or skip. */
export type GuruSubscriptionStatus =
  | 'active'
  | 'canceled'
  | 'overdue'
  | (string & NonNullable<unknown>); // allow unknown statuses for graceful handling

// ---------------------------------------------------------------------------
// Transaction payload
// ---------------------------------------------------------------------------

export interface GuruContact {
  name: string;
  /** BR-PRIVACY-001: PII — do not log */
  email: string;
  /** BR-PRIVACY-001: PII — do not log — CPF/CNPJ */
  doc?: string | null;
  /** BR-PRIVACY-001: PII — do not log */
  phone_number?: string | null;
  phone_local_code?: string | null;
  /**
   * Shipping/billing address. Guru sends this as a structured object on most
   * plans but may send a plain string (e.g. "Rua Acre") on others.
   * The Zod schema in guru-raw-events-processor.ts coerces string → null
   * because city/state/zip cannot be reliably extracted from a freeform string.
   */
  address?:
    | string
    | {
        city?: string | null;
        state?: string | null;
        zip_code?: string | null;
        country?: string | null;
      }
    | null;
}

export interface GuruPaymentInstallments {
  qty: number;
  /** Amount per installment in centavos */
  value: number;
}

export interface GuruPayment {
  method: string;
  /** Total amount in centavos — divide by 100 for monetary unit */
  total: number;
  /** Gross amount in centavos */
  gross: number;
  /** Net amount in centavos */
  net: number;
  currency: string;
  installments?: GuruPaymentInstallments | null;
}

export interface GuruProductOffer {
  id: string;
  name: string;
}

export interface GuruProduct {
  id: string;
  name: string;
  type: string;
  offer?: GuruProductOffer | null;
}

export interface GuruSource {
  utm_source?: string | null;
  utm_campaign?: string | null;
  utm_medium?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  /** pptc — GlobalTracker lead_public_id propagated via custom UTM */
  pptc?: string | null;
}

export interface GuruTransactionPayload {
  webhook_type: 'transaction';
  /** BR-PRIVACY-001: do not log — workspace authentication token */
  api_token: string;
  /** UUID of the transaction — used as platform_event_id */
  id: string;
  type?: string | null;
  status: GuruTransactionStatus;
  created_at?: string | null;
  confirmed_at?: string | null;
  contact: GuruContact;
  payment: GuruPayment;
  product?: GuruProduct | null;
  source?: GuruSource | null;
}

// ---------------------------------------------------------------------------
// Subscription payload
// ---------------------------------------------------------------------------

export interface GuruSubscriber {
  id?: string | null;
  /** BR-PRIVACY-001: PII — do not log */
  name?: string | null;
  /** BR-PRIVACY-001: PII — do not log */
  email?: string | null;
  /** BR-PRIVACY-001: PII — do not log — CPF/CNPJ */
  doc?: string | null;
}

export interface GuruCurrentInvoice {
  id: string;
  status: string;
  /** Invoice value in centavos */
  value: number;
  cycle?: number | null;
}

export interface GuruSubscriptionPayload {
  webhook_type: 'subscription';
  /** BR-PRIVACY-001: do not log — workspace authentication token */
  api_token: string;
  /** Subscription ID (e.g. sub_BOAEj2WTKoclmg4X) — used as platform_event_id */
  id: string;
  internal_id?: string | null;
  subscription_code?: string | null;
  name?: string | null;
  /** Current subscription status */
  last_status: GuruSubscriptionStatus;
  provider?: string | null;
  payment_method?: string | null;
  charged_every_days?: number | null;
  subscriber?: GuruSubscriber | null;
  current_invoice?: GuruCurrentInvoice | null;
}

// ---------------------------------------------------------------------------
// E-ticket payload (Fase 4+ — skipped in Fase 3)
// ---------------------------------------------------------------------------

export interface GuruEticketPayload {
  webhook_type: 'eticket';
  /** BR-PRIVACY-001: do not log */
  api_token: string;
  id?: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type GuruWebhookPayload =
  | GuruTransactionPayload
  | GuruSubscriptionPayload
  | GuruEticketPayload;
