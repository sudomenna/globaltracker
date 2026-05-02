/**
 * Google Ads Conversion Upload mapper — pure function, no I/O.
 *
 * Maps an internal event + launch config to a Google Ads uploadClickConversions
 * payload.
 *
 * T-4-005
 * BR-DISPATCH-001: idempotency_key derivation uses conversion_action as
 *   destination_subresource.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Attribution data carrying click IDs. */
export interface EventAttribution {
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
}

/** Minimal shape of an event row consumed by this dispatcher. */
export interface ConversionUploadEvent {
  event_id: string;
  event_name: string;
  /** ISO 8601 string or Date — converted to Google's format internally. */
  event_time: Date | string;
  workspace_id: string;
  attribution?: EventAttribution | null;
  custom_data?: {
    value?: number | null;
    currency?: string | null;
    order_id?: string | null;
    [key: string]: unknown;
  } | null;
}

/** Subset of launch config relevant to Google Ads Conversion Upload. */
export interface GoogleAdsLaunchConfig {
  tracking?: {
    google?: {
      /** Google Ads Customer ID (without dashes, e.g. "1234567890"). */
      ads_customer_id?: string | null;
      /**
       * Map from internal event_name to Google Ads conversion action resource
       * name, e.g. "customers/1234567890/conversionActions/987654321".
       */
      conversion_actions?: Record<string, string> | null;
    } | null;
  } | null;
}

/** Single click conversion payload for Google Ads uploadClickConversions API. */
export interface ConversionUploadPayload {
  /** Google Ads conversion action resource name. */
  conversion_action: string;
  /**
   * Conversion date/time in Google's required format:
   * "YYYY-MM-DD HH:MM:SS+00:00"
   */
  conversion_date_time: string;
  /** Google Click Identifier. Mutually exclusive with gbraid/wbraid. */
  gclid?: string;
  /** Google Browser Attribution ID. Mutually exclusive with gclid. */
  gbraid?: string;
  /** Web Attribution ID. Mutually exclusive with gclid. */
  wbraid?: string;
  /** Conversion value in the currency's base unit (e.g. 197.00 for BRL). */
  conversion_value?: number;
  /** ISO 4217 currency code. */
  currency_code?: string;
  /** Order ID for deduplication — recommended for Enhanced Conversions. */
  order_id?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maps an internal event to a Google Ads uploadClickConversions single-item
 * payload.
 *
 * Pure function — no I/O, no side effects, fully testable.
 *
 * T-4-005
 * BR-DISPATCH-001: conversion_action is the destination_subresource used in
 *   idempotency_key derivation.
 *
 * Click ID priority: gclid > gbraid > wbraid (spec §Eligibility).
 *
 * @param event        - internal event row (or subset)
 * @param launchConfig - launch config containing google.conversion_actions map
 */
export function mapEventToConversionUpload(
  event: ConversionUploadEvent,
  launchConfig: GoogleAdsLaunchConfig,
): ConversionUploadPayload {
  // Resolve conversion_action from launch config.
  const conversionAction =
    launchConfig.tracking?.google?.conversion_actions?.[event.event_name];

  if (!conversionAction) {
    throw new Error(
      `google_ads_mapper: no conversion_action mapped for event '${event.event_name}'`,
    );
  }

  // Format event_time as "YYYY-MM-DD HH:MM:SS+00:00" (Google's required format).
  const conversionDateTime = formatConversionDateTime(event.event_time);

  // BR-DISPATCH-001: click ID priority — gclid > gbraid > wbraid.
  const payload: ConversionUploadPayload = {
    conversion_action: conversionAction,
    conversion_date_time: conversionDateTime,
  };

  const attr = event.attribution;
  if (attr?.gclid) {
    payload.gclid = attr.gclid;
  } else if (attr?.gbraid) {
    payload.gbraid = attr.gbraid;
  } else if (attr?.wbraid) {
    payload.wbraid = attr.wbraid;
  }
  // If no click ID, caller (eligibility) should have blocked before reaching mapper.

  // Optional monetisation fields.
  if (typeof event.custom_data?.value === 'number') {
    payload.conversion_value = event.custom_data.value;
  }
  if (typeof event.custom_data?.currency === 'string') {
    payload.currency_code = event.custom_data.currency;
  }
  if (typeof event.custom_data?.order_id === 'string') {
    payload.order_id = event.custom_data.order_id;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Formats a Date or ISO string to Google's required conversion_date_time
 * format: "YYYY-MM-DD HH:MM:SS+00:00".
 *
 * Google rejects ISO 8601 (with T separator). The UTC offset must be explicit.
 */
export function formatConversionDateTime(eventTime: Date | string): string {
  const d = typeof eventTime === 'string' ? new Date(eventTime) : eventTime;

  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  const seconds = String(d.getUTCSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}+00:00`;
}
