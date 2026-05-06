/**
 * Google Ads Enhanced Conversions mapper — pure function, no I/O.
 *
 * Maps an internal event + lead row to the conversionAdjustments:upload payload.
 *
 * T-4-006
 * BR-DISPATCH-001: idempotency_key derivation uses conversion_action as subresource.
 * BR-CONSENT-003: hashed_email and hashed_phone_number only present when lead lookup succeeded.
 *
 * NOTE on hash normalization:
 *   Google Enhanced Conversions requires:
 *     - email:  sha256(email.toLowerCase().trim())
 *     - phone:  sha256(normalizeE164(phone))   (E.164: digits only, leading +)
 *
 *   GlobalTracker stores lead.email_hash and lead.phone_hash as SHA-256 hex computed
 *   by the ingestion layer (lib/pii.ts) following the same normalization rules.
 *   Therefore hashes are passed through as-is — re-hashing is NOT performed here.
 *   Normalization pre-hash is the responsibility of the ingestion layer.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of an event row as consumed by this dispatcher. */
export interface DispatchableEvent {
  event_id: string;
  event_name: string;
  /** ISO-8601 string or Date object. */
  event_time: Date | string;
  lead_id?: string | null;
  workspace_id: string;
  custom_data?: Record<string, unknown> | null;
  consent_snapshot?: Record<string, unknown> | null;
}

/** Minimal shape of a lead row as consumed by this dispatcher. */
export interface DispatchableLead {
  /** SHA-256 hex puro de email normalizado. */
  email_hash_external?: string | null;
  /** SHA-256 hex puro de phone E.164. */
  phone_hash_external?: string | null;
  /** SHA-256 hex puro do first name lowercase. */
  fn_hash?: string | null;
  /** SHA-256 hex puro do last name lowercase. */
  ln_hash?: string | null;
}

/** Subset of launches.config relevant to Google Enhanced Conversions. */
export interface EnhancedConversionsLaunchConfig {
  tracking?: {
    google?: {
      /**
       * Map of internal event_name → Google conversion_action resource name.
       * e.g. "Purchase" → "customers/1234567890/conversionActions/987654321"
       */
      conversion_actions?: Record<string, string> | null;
      /** Google Ads customer ID (without dashes). */
      ads_customer_id?: string | null;
    } | null;
  } | null;
}

/** A single user identifier in the Google Ads format. */
export interface GoogleUserIdentifier {
  /** SHA-256 hex de email normalizado. */
  hashedEmail?: string;
  /** SHA-256 hex de phone E.164. */
  hashedPhoneNumber?: string;
  /**
   * Address info for Enhanced Conversions for leads.
   * Google Ads API spec: ConversionAdjustment.userIdentifiers[].addressInfo
   */
  addressInfo?: {
    hashedFirstName?: string;
    hashedLastName?: string;
  };
}

/** The conversionAdjustment object sent to Google Ads API. */
export interface EnhancedConversionPayload {
  /**
   * Resource name of the conversion action.
   * e.g. "customers/1234567890/conversionActions/987654321"
   */
  conversionAction: string;
  /**
   * Identifies the original conversion to adjust.
   * Maps to events.custom_data.order_id.
   */
  orderId: string;
  /**
   * RFC-3339 / Google format: "YYYY-MM-DD HH:MM:SS+00:00"
   */
  adjustmentDateTime: string;
  /** Always 'ENHANCEMENT' for Enhanced Conversions. */
  adjustmentType: 'ENHANCEMENT';
  /** Hashed user identifiers for enhanced matching. */
  userIdentifiers: GoogleUserIdentifier[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Formats a Date or ISO string as "YYYY-MM-DD HH:MM:SS+00:00" (Google's required format).
 */
function formatAdjustmentDateTime(eventTime: Date | string): string {
  const d = typeof eventTime === 'string' ? new Date(eventTime) : eventTime;

  const pad = (n: number): string => String(n).padStart(2, '0');

  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const seconds = pad(d.getUTCSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}+00:00`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maps an internal event + lead to a Google Ads Enhanced Conversion payload.
 *
 * Pure function — no I/O, no side effects, fully testable.
 *
 * T-4-006
 * BR-DISPATCH-001: conversion_action is the subresource for idempotency_key derivation.
 * BR-CONSENT-003: hashed user identifiers only present when lead lookup succeeded.
 *
 * @param event        - internal event row (or subset of it)
 * @param lead         - resolved lead row for enrichment
 * @param launchConfig - launch configuration containing tracking.google.conversion_actions
 * @returns EnhancedConversionPayload ready to be sent to conversionAdjustments:upload
 */
export function mapEventToEnhancedConversion(
  event: DispatchableEvent,
  lead: DispatchableLead | null | undefined,
  launchConfig: EnhancedConversionsLaunchConfig,
): EnhancedConversionPayload {
  // Resolve the conversion_action for this event_name.
  // BR-DISPATCH-001: conversion_action is the destination_subresource.
  const conversionAction =
    launchConfig.tracking?.google?.conversion_actions?.[event.event_name] ?? '';

  // Extract order_id from custom_data.
  const orderId =
    typeof event.custom_data?.order_id === 'string'
      ? event.custom_data.order_id
      : '';

  // Format adjustment_date_time to Google's required format.
  const adjustmentDateTime = formatAdjustmentDateTime(event.event_time);

  // Build user identifiers.
  // BR-CONSENT-003: em/ph only from lead lookup; do NOT re-hash — already SHA-256 hex.
  // Normalization pre-hash is the responsibility of the ingestion layer (lib/pii.ts).
  const userIdentifiers: GoogleUserIdentifier[] = [];

  // BR-CONSENT-003: usar hashes externos (SHA-256 puro)
  if (lead?.email_hash_external) {
    userIdentifiers.push({ hashedEmail: lead.email_hash_external });
  }
  if (lead?.phone_hash_external) {
    userIdentifiers.push({ hashedPhoneNumber: lead.phone_hash_external });
  }
  if (lead?.fn_hash || lead?.ln_hash) {
    const addressInfo: { hashedFirstName?: string; hashedLastName?: string } = {};
    if (lead.fn_hash) addressInfo.hashedFirstName = lead.fn_hash;
    if (lead.ln_hash) addressInfo.hashedLastName = lead.ln_hash;
    userIdentifiers.push({ addressInfo });
  }

  return {
    conversionAction,
    orderId,
    adjustmentDateTime,
    adjustmentType: 'ENHANCEMENT',
    userIdentifiers,
  };
}
