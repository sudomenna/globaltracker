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

/**
 * Item type discriminator. Confirmed via real purchase 2026-05-10 17:34 UTC:
 * a single OnProfit order can fire N webhooks (1 main product + N order_bumps),
 * each with its own webhook id but sharing the same `offer_hash`. Wave 3 will
 * use this to derive `transaction_group_id` and skip dispatch on order_bumps.
 *
 * Open enum: tolerate future OnProfit values gracefully.
 */
export type OnProfitItemType =
  | 'product'
  | 'order_bump'
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
// Transaction (gateway-level detail, present in PAID/AUTHORIZED payloads)
// ---------------------------------------------------------------------------

/**
 * Gateway transaction detail present in PAID / AUTHORIZED webhooks.
 * Real payload (2026-05-10): an array of one or more transaction records
 * carrying gateway internals. We type only the stable fields we may use; the
 * rest is preserved as `additional_data` to avoid coupling to gateway shape.
 */
export interface OnProfitTransaction {
  id: number;
  amount: number;
  status: OnProfitStatus;
  gateway: string;
  order_id?: number | null;
  installments?: number | null;
  payment_method?: OnProfitPaymentType | null;
  installment_fee?: string | null;
  gateway_version?: string | null;
  gateway_integration_id?: number | null;
  gateway_transaction_id?: string | null;
  /** Loose gateway-specific fields (card_id, trans_id, charge_id, …) */
  additional_data?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Subscription (currently null in observed payload — leave loose)
// ---------------------------------------------------------------------------

export type OnProfitSubscription = Record<string, unknown> | null;

// ---------------------------------------------------------------------------
// Custom fields (operator-defined; may carry lead_public_id)
// ---------------------------------------------------------------------------

/**
 * Real-world shape (confirmed 2026-05-10): OnProfit sends `custom_fields` as
 *   - an empty array `[]` when the operator did not configure custom fields
 *     in the checkout (this is the default and most common case),
 *   - an object mapping custom-field keys to values when configured,
 *   - or `null` (defensive — observed in some legacy payloads).
 *
 * Consumers MUST narrow with `Array.isArray(custom_fields)` before reading
 * `lead_public_id` — accessing `.lead_public_id` on the array form is a type
 * error (and would yield `undefined` at runtime).
 */
export type OnProfitCustomFields =
  | unknown[]
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
  /**
   * Discriminator between the main product webhook and order bump webhooks
   * fired for the same order. Confirmed in production payload (2026-05-10).
   * Wave 3 uses this to skip dispatch for `order_bump` events while still
   * persisting them under a shared `transaction_group_id`.
   */
  item_type?: OnProfitItemType | null;
  user_id?: number | null;
  customer_id?: number | null;
  /**
   * For `item_type='product'`: equals `product.id`.
   * For `item_type='order_bump'`: points to the MAIN product's id (the one
   * the order_bump is attached to), not to `product.id` of this row.
   * Useful as a parent reference when grouping transactions.
   */
  product_id?: number | null;
  /**
   * Numeric link to a product. In observed payloads (2026-05-10) it equals
   * the row's own `product.id` for both main products and order bumps.
   * Treat as opaque — kept for forward compatibility / debugging.
   */
  product_link?: number | null;
  delivery?: number | null;
  offer_id?: number | null;
  /**
   * Stable offer hash shared across the main product and all order bumps of
   * the same checkout. CRITICAL: Wave 3 derives `transaction_group_id` from
   * this so that N webhooks (1 main + N order_bumps) of one purchase
   * collapse into one canonical Purchase event.
   */
  offer_hash?: string | null;
  offer_name?: string | null;
  /** CENTAVOS — divide by 100 before storing as currency unit */
  offer_price?: number | null;
  /** CENTAVOS — divide by 100 before storing as currency unit */
  price: number;
  /**
   * Affiliate / producer commission in currency unit (NOT centavos),
   * delivered as a string (e.g. "200", "97"). Parse with `Number()` only at
   * the point of use; we keep it raw to avoid lossy precision conversions.
   */
  comission?: string | null;
  /**
   * Gateway-level transaction details. Present on PAID / AUTHORIZED webhooks;
   * absent / null on STARTED / WAITING. Treated as advisory — primary status
   * comes from root `status`, not from `transactions[].status`.
   */
  transactions?: OnProfitTransaction[] | null;
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
