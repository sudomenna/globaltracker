/**
 * types.ts — TypeScript types for OnProfit webhook payloads.
 *
 * Spec source: real payload + status enum confirmed with usuário (2026-05-09).
 * No canonical doc yet under docs/40-integrations/ — when the integration is
 * formalized, mirror this shape there.
 *
 * BR-PRIVACY-001: Fields containing PII (customer.email, customer.cell,
 * customer.phone, customer.document, customer.name + lastname, customer_address)
 * are present here as raw strings. The OnProfit raw_events processor is
 * responsible for hashing / encrypting before persisting in lead_aliases /
 * leads.email_enc. Never log these fields directly.
 *
 * Notable OnProfit semantics:
 *   - `price` and `offer_price` are in CENTAVOS (integer cents).
 *     Example: 9700 = R$ 97,00. The processor divides by 100 before storing
 *     `events.custom_data.amount` in unit currency (BRL float).
 *   - `customer.cell` is already E.164-formatted (e.g. "+5521999998888").
 *     `customer.phone` is the masked / display form (e.g. "(21) 99999-8888").
 *     Lead resolution prefers `cell` over `phone`.
 *   - `fbc` / `fbp` carry Meta browser cookies natively — the entire reason
 *     this adapter exists. When non-null they must be propagated to
 *     events.user_data.fbc / events.user_data.fbp for Meta CAPI dispatch.
 *   - `src` and `sck` are loosely-typed extra parameters; we store them raw
 *     under custom_data without attempting to map them.
 */

// ---------------------------------------------------------------------------
// OnProfit status enum (inbound)
// ---------------------------------------------------------------------------

export type OnProfitStatus =
  | 'STARTED'
  | 'WAITING'
  | 'PAID'
  | 'AUTHORIZED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'CHARGEBACK'
  | (string & NonNullable<unknown>); // tolerate unknown statuses for graceful skip

export type OnProfitPaymentType =
  | 'cc'
  | 'pix'
  | 'boleto'
  | (string & NonNullable<unknown>);

// ---------------------------------------------------------------------------
// Customer (PII — never log)
// ---------------------------------------------------------------------------

export interface OnProfitCustomer {
  /** BR-PRIVACY-001: PII — first name */
  name: string;
  /** BR-PRIVACY-001: PII — last name */
  lastname: string;
  /** BR-PRIVACY-001: PII — CPF/CNPJ */
  document?: string | null;
  /** BR-PRIVACY-001: PII */
  email: string;
  /** BR-PRIVACY-001: PII — display-formatted phone, e.g. "(21) 99999-8888" */
  phone?: string | null;
  /** BR-PRIVACY-001: PII — E.164 phone, e.g. "+5521999998888" — preferred */
  cell?: string | null;
}

// ---------------------------------------------------------------------------
// Customer address — used for geo enrichment of events.user_data
// ---------------------------------------------------------------------------

export interface OnProfitCustomerAddress {
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  /** Mapped to events.user_data.geo_city */
  city?: string | null;
  /** Mapped to events.user_data.geo_region_code (e.g. "RJ") */
  state?: string | null;
  /** Mapped to events.user_data.geo_postal_code */
  zip_code?: string | null;
  neighborhood?: string | null;
  /** Mapped to events.user_data.geo_country (e.g. "BR") */
  country?: string | null;
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

export interface OnProfitProduct {
  id: number;
  name: string;
  hash?: string | null;
}

// ---------------------------------------------------------------------------
// Subscription (currently null in observed payload — leave loose)
// ---------------------------------------------------------------------------

export type OnProfitSubscription = Record<string, unknown> | null;

// ---------------------------------------------------------------------------
// Custom fields (operator-defined; may carry lead_public_id)
// ---------------------------------------------------------------------------

export type OnProfitCustomFields =
  | (Record<string, unknown> & {
      /**
       * BR-WEBHOOK-004: highest-priority lead resolution signal when present.
       * Operator must inject this into the OnProfit checkout link as a custom
       * field for the integration to leverage GlobalTracker's pptc.
       */
      lead_public_id?: string | null;
    })
  | null;

// ---------------------------------------------------------------------------
// Root payload
// ---------------------------------------------------------------------------

export interface OnProfitWebhookPayload {
  object: 'order' | (string & NonNullable<unknown>);
  /** OnProfit order/transaction id — used as platform_event_id */
  id: number;
  item_type?: string | null;
  user_id?: number | null;
  customer_id?: number | null;
  product_id?: number | null;
  delivery?: number | null;
  offer_id?: number | null;
  offer_hash?: string | null;
  offer_name?: string | null;
  /** CENTAVOS — divide by 100 before storing as currency unit */
  offer_price?: number | null;
  /** CENTAVOS — divide by 100 before storing as currency unit */
  price: number;
  currency: string;
  payment_type?: OnProfitPaymentType | null;
  /** ISO-like "YYYY-MM-DD HH:mm:ss" (no timezone — assumed BRT/UTC-3) */
  purchase_date?: string | null;
  status: OnProfitStatus;
  confirmation_purchase_date?: string | null;
  smartpayment?: number | null;

  // ---- Attribution ----
  /** Raw concatenated query-string blob */
  utm?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_term?: string | null;
  utm_content?: string | null;

  // ---- Meta tracking cookies (the reason this integration exists) ----
  /** Meta CAPI fbp cookie value — propagate to events.user_data.fbp */
  fbp?: string | null;
  /** Meta CAPI fbc cookie value — propagate to events.user_data.fbc */
  fbc?: string | null;
  /** Loose extra parameter — stored raw under custom_data.src */
  src?: string | null;
  /** Loose extra parameter — stored raw under custom_data.sck */
  sck?: string | null;

  subscription?: OnProfitSubscription;

  customer: OnProfitCustomer;
  customer_address?: OnProfitCustomerAddress | null;

  refuse_reason?: string | null;
  status_reason?: string | null;
  response_code?: string | null;
  response_message?: string | null;

  product: OnProfitProduct;
  custom_fields?: OnProfitCustomFields;
}
