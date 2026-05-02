/**
 * Types for the Funil tracker bundle.
 * Kept minimal — tracker is vanilla TS, zero runtime deps (INV-TRACKER-002).
 */

// PixelPolicy mirrors docs/30-contracts/01-enums.md
export type PixelPolicy =
  | 'server_only'
  | 'browser_and_server_managed'
  | 'coexist_with_existing_pixel';

// ConsentValue mirrors docs/30-contracts/01-enums.md
export type ConsentValue = 'granted' | 'denied' | 'unknown';

export interface ConsentSnapshot {
  analytics: ConsentValue;
  marketing: ConsentValue;
  ad_user_data: ConsentValue;
  ad_personalization: ConsentValue;
  /** ConsentFinality: customer_match — optional, defaults to 'unknown' in payloads. */
  customer_match?: ConsentValue;
}

export interface EventConfig {
  auto_page_view: boolean;
  events_enabled: string[];
}

export interface TrackerConfig {
  event_config: EventConfig;
  pixel_policy: PixelPolicy;
  endpoints: {
    events: string;
    lead: string;
  };
  schema_version: number;
  lead_token_settings: {
    ttl_days: number;
  };
  /**
   * Consent snapshot from the Edge config response.
   * If absent, tracker defaults to 'unknown' for all finalities.
   * BR-CONSENT-004: consent_analytics='denied' → tracker transitions to 'paused'.
   */
  consent?: ConsentSnapshot;
}

/** Platform cookies captured (read-only — tracker never creates these). */
export interface PlatformCookies {
  _gcl_au: string | null;
  _ga: string | null;
  fbc: string | null;
  fbp: string | null;
}

/** Attribution params persisted in localStorage. */
export interface AttributionParams {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  fbclid: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
}

/**
 * Tracker states.
 * loading → initialized → ready
 *                       → paused (consent denied)
 */
export type TrackerStatus = 'loading' | 'initialized' | 'ready' | 'paused';

export interface TrackerState {
  status: TrackerStatus;
  siteToken: string | null;
  launchPublicId: string | null;
  pagePublicId: string | null;
  config: TrackerConfig | null;
  /** lead_token — read from __ftk cookie (backend sets it — INV-TRACKER-004). */
  leadToken: string | null;
  /** lead_public_id — opaque, cross-domain propagation via URL params. */
  leadPublicId: string | null;
  /**
   * Anonymous visitor ID — from __fvid cookie.
   * INV-TRACKER-003: only populated when consent_analytics='granted'.
   * Set by ensureVisitorId() during init; never changed by identify().
   */
  visitorId: string | null;
  attributionParams: AttributionParams;
  platformCookies: PlatformCookies;
  consent: ConsentSnapshot;
}

export interface IdentifyOptions {
  /** INV-TRACKER-008 / BR-TRACKER-001: only lead_token accepted — never lead_id in clear. */
  lead_token: string;
  /** Opaque public ID, safe to propagate in URLs. */
  lead_public_id?: string;
}

export interface FunilApi {
  /**
   * Track a named event (stub in Onda 1 — wired in Onda 2).
   */
  track(eventName: string, customData?: Record<string, unknown>): void;

  /**
   * Identify the current visitor by lead_token.
   * BR-TRACKER-001: only lead_token accepted, never lead_id in clear.
   * INV-TRACKER-008: ADR-006.
   */
  identify(options: IdentifyOptions): void;

  /**
   * Decorate links matching selectorOrElement with attribution params + lead_public_id.
   * Handles cross-domain: cookies do not cross domains, so params are appended to URLs.
   */
  decorate(
    selectorOrElement:
      | string
      | HTMLAnchorElement
      | NodeList
      | HTMLAnchorElement[],
  ): void;

  /**
   * Manually trigger a PageView event (stub in Onda 1 — wired in Onda 2).
   */
  page(): void;

  /**
   * Clear lead_token from client state.
   * Does NOT revoke server-side (INV-TRACKER-004: __ftk is set by backend).
   */
  logout(): void;
}
