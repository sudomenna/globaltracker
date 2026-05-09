/**
 * Funil Tracker — entry point.
 *
 * Installs window.Funil API. Auto-initializes from script data attributes.
 *
 * Data attributes on the <script> tag:
 *   data-site-token        — page token (X-Funil-Site header)
 *   data-launch-public-id  — launch public ID
 *   data-page-public-id    — page public ID
 *
 * Invariants:
 *   INV-TRACKER-001: bundle < 15 KB gzipped
 *   INV-TRACKER-002: zero runtime dependencies
 *   INV-TRACKER-005: never send PII in clear — only hashes, platform cookies, lead_token
 *   INV-TRACKER-006: browser_and_server_managed → same event_id for Pixel browser and CAPI
 *   INV-TRACKER-007: failure in /v1/config or /v1/events degrades silently
 *   INV-TRACKER-008: identify() only accepts lead_token (ADR-006)
 *
 * BRs:
 *   BR-TRACKER-001: Funil.identify exige lead_token, não lead_id em claro
 *   BR-CONSENT-004: cookies próprios só quando consent_analytics='granted'
 */

import { fetchConfig, sendEvent } from './api-client';
import type { EventPayload } from './api-client';
import {
  buildFbcFromFbclid,
  capturePlatformCookies,
  ensureVisitorId,
  readLeadTokenCookie,
} from './cookies';
import { decorate } from './decorate';
import { createEventId, getOrCreateEventId } from './pixel-coexist';
import {
  getState,
  setAttribution,
  setConfig,
  setLeadPublicId,
  setLeadToken,
  setPlatformCookies,
  setState,
  setVisitorId,
  transition,
} from './state';
import { captureAndPersistAttribution, clearAttribution } from './storage';
import type {
  AttributionParams,
  ConsentSnapshot,
  FunilApi,
  IdentifyOptions,
  PlatformCookies,
} from './types';

/** Base URL for Edge API — overridden at init from data-edge-url attribute. */
let EDGE_BASE_URL = '';

/** Default consent snapshot — returned when config is unavailable. */
const DEFAULT_CONSENT: ConsentSnapshot = {
  analytics: 'granted',
  marketing: 'granted',
  ad_user_data: 'granted',
  ad_personalization: 'granted',
  customer_match: 'granted',
};

/**
 * Find the currently executing script element to read data attributes.
 * Works with both sync and async/defer loading.
 */
function getCurrentScript(): HTMLScriptElement | null {
  try {
    if (typeof document === 'undefined') return null;
    // document.currentScript works synchronously
    if (document.currentScript instanceof HTMLScriptElement) {
      return document.currentScript;
    }
    // Fallback: find the script by data-site-token
    return document.querySelector<HTMLScriptElement>('script[data-site-token]');
  } catch {
    return null;
  }
}

/**
 * Read tracker configuration from script data attributes.
 */
function readDataAttributes(): {
  siteToken: string | null;
  launchPublicId: string | null;
  pagePublicId: string | null;
  edgeUrl: string | null;
} {
  const script = getCurrentScript();
  if (!script) {
    return { siteToken: null, launchPublicId: null, pagePublicId: null, edgeUrl: null };
  }
  return {
    siteToken: script.dataset.siteToken ?? null,
    launchPublicId: script.dataset.launchPublicId ?? null,
    pagePublicId: script.dataset.pagePublicId ?? null,
    edgeUrl: script.dataset.edgeUrl ?? null,
  };
}

/**
 * Build attribution record for event payload from AttributionParams.
 * Null values are kept to satisfy the Record<string, string | null> shape.
 */
function buildAttributionRecord(
  params: AttributionParams,
): Record<string, string | null> {
  return {
    utm_source: params.utm_source,
    utm_medium: params.utm_medium,
    utm_campaign: params.utm_campaign,
    utm_content: params.utm_content,
    utm_term: params.utm_term,
    fbclid: params.fbclid,
    gclid: params.gclid,
    gbraid: params.gbraid,
    wbraid: params.wbraid,
  };
}

/**
 * Build user_data record for event payload from PlatformCookies + attribution.
 *
 * INV-TRACKER-005: only platform cookies — never PII in clear.
 *
 * `fbc` fallback: when the `_fbc` cookie is absent (page does not have the Meta
 * Pixel SDK loaded, or visitor arrived before Pixel initialized), but `fbclid`
 * exists in the URL, we synthesize the canonical Meta `_fbc` value
 * (`fb.1.{ts}.{fbclid}`) so the click attribution still reaches Meta CAPI.
 */
function buildUserDataRecord(
  cookies: PlatformCookies,
  attribution: AttributionParams,
): Record<string, string | null> {
  return {
    _gcl_au: cookies._gcl_au,
    _ga: cookies._ga,
    fbc: cookies.fbc ?? buildFbcFromFbclid(attribution.fbclid),
    fbp: cookies.fbp,
  };
}

/**
 * Initialize the tracker.
 * loading → initialized (after config fetch attempt) → ready (after initial captures)
 * INV-TRACKER-007: any failure in /v1/config keeps page working; tracker degrades.
 */
async function init(): Promise<void> {
  try {
    const { siteToken, launchPublicId, pagePublicId, edgeUrl } = readDataAttributes();

    if (edgeUrl) EDGE_BASE_URL = edgeUrl.replace(/\/$/, '');

    setState({ siteToken, launchPublicId, pagePublicId });

    // Fetch config — INV-TRACKER-007: failure returns null, tracker degrades gracefully
    let config = null;
    if (siteToken && launchPublicId && pagePublicId) {
      config = await fetchConfig(
        siteToken,
        launchPublicId,
        pagePublicId,
        EDGE_BASE_URL,
      );
    }

    setConfig(config);
    // loading → initialized (with or without config)
    transition('initialized');

    // Capture platform cookies (read-only — INV-TRACKER-004)
    const platformCookies = capturePlatformCookies();
    setPlatformCookies(platformCookies);

    // Capture attribution params from URL + localStorage
    const attribution = captureAndPersistAttribution();
    setAttribution(attribution);

    // Read __ftk (lead_token) from cookie — backend sets it (INV-TRACKER-004).
    // Only overwrite state.leadToken when the cookie carries a value: a snippet
    // running on DOMContentLoaded may have already called Funil.identify(token)
    // (token sourced from localStorage when the cookie is unavailable cross-origin
    // — see BR-IDENTITY-005), and the async init() must not erase it.
    const leadToken = readLeadTokenCookie();
    if (leadToken) {
      setLeadToken(leadToken);
    }

    // initialized → ready
    transition('ready');

    // BR-CONSENT-004: if consent_analytics='denied', pause tracker — no events emitted
    if (config?.consent?.analytics === 'denied') {
      transition('paused');
      return;
    }

    // INV-TRACKER-003: generate/read __fvid only when consent_analytics is not denied.
    // BR-CONSENT-004: defaultar a granted — só pausa __fvid quando explicitamente 'denied'.
    // Como L189 já fez early-return para 'denied', alcançar este ponto significa que
    // analytics é 'granted' | 'unknown' | undefined — todos liberam __fvid (alinhado com
    // DEFAULT_CONSENT, linhas 57-63). Mantemos a flag explícita para legibilidade.
    // Funil.identify() must NOT alter __fvid — it belongs to the anonymous visitor, not the lead.
    const consentAnalytics = true;
    const visitorId = ensureVisitorId(consentAnalytics);
    setVisitorId(visitorId);

    // Auto page view
    if (config?.event_config?.auto_page_view) {
      _funil.page();
    }
  } catch {
    // INV-TRACKER-007: any unhandled error must not surface to host page
    // Best-effort: try to reach 'initialized' at minimum
    try {
      transition('initialized');
    } catch {
      // ignore
    }
  }
}

/**
 * Funil.track() — send a named event to /v1/events.
 *
 * T-2-005: builds the full CONTRACT-api-events-v1 payload and sends it.
 * T-2-011 / INV-TRACKER-006: uses createEventId() so that the browser Pixel
 *   (when policy = 'browser_and_server_managed') reads the same id via
 *   window.__funil_event_id.
 *
 * INV-TRACKER-005: never sends PII in clear — only platform cookies & lead_token.
 * INV-TRACKER-007: failure in fetch does not throw.
 * BR-CONSENT-004: if state is 'paused', no events are sent.
 */
function track(eventName: string, customData?: Record<string, unknown>): void {
  try {
    const state = getState();

    // BR-CONSENT-004: paused state means consent_analytics was denied
    if (state.status === 'paused') return;

    if (!eventName) return;

    // Required IDs must be present for the request to be meaningful
    const { siteToken, launchPublicId, pagePublicId } = state;
    if (!siteToken || !launchPublicId || !pagePublicId) return;

    // INV-TRACKER-006: create a new event_id and expose on window.__funil_event_id
    // so the inline browser Pixel script can use the same id for dedup at CAPI.
    const pixelPolicy = state.config?.pixel_policy ?? 'server_only';
    const event_id =
      pixelPolicy === 'browser_and_server_managed'
        ? createEventId(eventName)
        : getOrCreateEventId(eventName);

    const consent: ConsentSnapshot = state.config?.consent ?? DEFAULT_CONSENT;

    const payload: EventPayload = {
      event_id,
      schema_version: 1,
      launch_public_id: launchPublicId,
      page_public_id: pagePublicId,
      event_name: eventName,
      event_time: new Date().toISOString(),
      attribution: buildAttributionRecord(state.attributionParams),
      // Re-capture platform cookies at send-time (not from state).
      // Race fix: state.platformCookies is set inside init() AFTER `await fetchConfig(...)`.
      // Snippets that fire track/page from DOMContentLoaded (e.g. thankyou pages with
      // auto_page_view=false) may reach track() while init() is still awaiting config —
      // state would still be the default { _gcl_au: null, _ga: null, fbc: null, fbp: null }
      // and the event would ship empty user_data even though Pixel/GA already set the cookies.
      // Reading document.cookie fresh is microseconds; cookies can also be set late by Pixel,
      // so fresh-read is more correct than cached state in any case.
      user_data: buildUserDataRecord(capturePlatformCookies(), state.attributionParams),
      custom_data: customData ?? {},
      consent: {
        analytics: consent.analytics,
        marketing: consent.marketing,
        ad_user_data: consent.ad_user_data,
        ad_personalization: consent.ad_personalization,
        customer_match: consent.customer_match ?? 'granted',
      },
    };

    // INV-TRACKER-008 / BR-TRACKER-001: include lead_token only — never lead_id in clear
    if (state.leadToken) {
      payload.lead_token = state.leadToken;
    }

    // INV-TRACKER-003: include visitor_id only when present (set after consent granted)
    // Backend uses this to retroactively link anonymous events to a lead (T-5-003)
    if (state.visitorId) {
      payload.visitor_id = state.visitorId;
    }

    // Fire and forget — INV-TRACKER-007
    sendEvent(siteToken, payload, EDGE_BASE_URL).catch(() => {
      // INV-TRACKER-007: unhandled promise rejection must not surface
    });
  } catch {
    // INV-TRACKER-007: fail silently
  }
}

/**
 * Funil.identify({lead_token}) — stores lead_token in state.
 *
 * BR-TRACKER-001: only lead_token accepted — never lead_id in clear.
 * INV-TRACKER-008: ADR-006. lead_id in clear is forbidden from browser.
 *
 * After identify(), the next track() / page() call will include the token
 * in the payload sent to /v1/events (T-2-004).
 *
 * __ftk cookie is SET by backend (Set-Cookie response from /v1/lead) — INV-TRACKER-004.
 * Tracker only reads __ftk, never writes it.
 */
function identify(options: IdentifyOptions): void {
  try {
    // BR-TRACKER-001: validate that lead_token is present and is a string
    if (
      !options ||
      typeof options.lead_token !== 'string' ||
      !options.lead_token
    ) {
      // INV-TRACKER-008: reject silently any option that is not lead_token
      return;
    }

    // INV-TRACKER-008: we accept only lead_token, never lead_id in clear
    setLeadToken(options.lead_token);

    if (options.lead_public_id) {
      setLeadPublicId(options.lead_public_id);
    }
  } catch {
    // INV-TRACKER-007: fail silently
  }
}

/**
 * Funil.page() — trigger a PageView event manually.
 * Delegates to track('PageView') which handles state + payload + send.
 */
function page(): void {
  try {
    const state = getState();
    if (state.status === 'paused') return;
    track('PageView');
  } catch {
    // INV-TRACKER-007: fail silently
  }
}

/**
 * Funil.logout() — clears lead_token from client state.
 *
 * INV-TRACKER-004: __ftk cookie was set by backend with HttpOnly flag — we cannot
 * clear it from JS. Logout only clears the in-memory state + attribution.
 * Server-side revocation is out of scope for the tracker.
 */
function logout(): void {
  try {
    setLeadToken(null);
    setLeadPublicId(null);
    clearAttribution();
  } catch {
    // INV-TRACKER-007: fail silently
  }
}

/** Public Funil API object. */
const _funil: FunilApi = {
  track,
  identify,
  decorate,
  page,
  logout,
};

// Install on window — do not overwrite if already present (script loaded twice guard)
if (typeof window !== 'undefined') {
  if (!(window as unknown as Record<string, unknown>).Funil) {
    (window as unknown as Record<string, unknown>).Funil = _funil;
  }
}

// Auto-init — wrapped in try/catch for INV-TRACKER-007
(function autoInit() {
  try {
    if (typeof document === 'undefined') return;

    const doInit = () => {
      init().catch(() => {
        // INV-TRACKER-007: unhandled promise rejection must not surface
      });
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', doInit, { once: true });
    } else {
      doInit();
    }
  } catch {
    // INV-TRACKER-007: fail silently
  }
})();

export { _funil as Funil };
export type { FunilApi };
