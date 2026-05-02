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
 *   INV-TRACKER-007: failure in /v1/config degrades silently
 *   INV-TRACKER-008: identify() only accepts lead_token (ADR-006)
 *
 * BRs:
 *   BR-TRACKER-001: Funil.identify exige lead_token, não lead_id em claro
 *   BR-CONSENT-004: cookies próprios só quando consent_analytics='granted'
 */

import { fetchConfig } from './api-client';
import { capturePlatformCookies, readLeadTokenCookie } from './cookies';
import { decorate } from './decorate';
import {
  getState,
  setAttribution,
  setConfig,
  setLeadPublicId,
  setLeadToken,
  setPlatformCookies,
  setState,
  transition,
} from './state';
import { captureAndPersistAttribution, clearAttribution } from './storage';
import type { FunilApi, IdentifyOptions } from './types';

/** Base URL for Edge API — can be overridden for testing. */
const EDGE_BASE_URL = '';

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
} {
  const script = getCurrentScript();
  if (!script) {
    return { siteToken: null, launchPublicId: null, pagePublicId: null };
  }
  return {
    siteToken: script.dataset.siteToken ?? null,
    launchPublicId: script.dataset.launchPublicId ?? null,
    pagePublicId: script.dataset.pagePublicId ?? null,
  };
}

/**
 * Initialize the tracker.
 * loading → initialized (after config fetch attempt) → ready (after initial captures)
 * INV-TRACKER-007: any failure in /v1/config keeps page working; tracker degrades.
 */
async function init(): Promise<void> {
  try {
    const { siteToken, launchPublicId, pagePublicId } = readDataAttributes();

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

    // Read __ftk (lead_token) from cookie — backend sets it (INV-TRACKER-004)
    const leadToken = readLeadTokenCookie();
    setLeadToken(leadToken);

    // initialized → ready
    transition('ready');

    // Auto page view if config says so (Onda 2 wires the actual send)
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
 * Funil.track() — stub in Onda 1, wired in Onda 2.
 */
function track(eventName: string, _customData?: Record<string, unknown>): void {
  try {
    const state = getState();
    if (state.status === 'paused') return;
    if (!eventName) return;
    // Onda 2 implements: build payload + sendEvent()
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
 * In Onda 1: stores token in state for later use.
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
      // Silent failure — do not throw
      return;
    }

    // INV-TRACKER-008: we accept only lead_token, never lead_id in clear
    // Storing in state for replay on next /v1/events call (Onda 2)
    setLeadToken(options.lead_token);

    if (options.lead_public_id) {
      setLeadPublicId(options.lead_public_id);
    }
  } catch {
    // INV-TRACKER-007: fail silently
  }
}

/**
 * Funil.page() — stub in Onda 1, wired in Onda 2.
 * Manually triggers a PageView event.
 */
function page(): void {
  try {
    const state = getState();
    if (state.status === 'paused') return;
    // Onda 2 implements: track('PageView')
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
