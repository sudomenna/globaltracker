/**
 * TrackerState machine.
 * States: loading → initialized → ready | paused
 * See: docs/20-domain/13-mod-tracker.md §5, §6
 */

import type {
  AttributionParams,
  ConsentSnapshot,
  PlatformCookies,
  TrackerConfig,
  TrackerState,
  TrackerStatus,
} from './types';

const DEFAULT_CONSENT: ConsentSnapshot = {
  analytics: 'unknown',
  marketing: 'unknown',
  ad_user_data: 'unknown',
  ad_personalization: 'unknown',
};

const DEFAULT_PLATFORM_COOKIES: PlatformCookies = {
  _gcl_au: null,
  _ga: null,
  fbc: null,
  fbp: null,
};

const DEFAULT_ATTRIBUTION: AttributionParams = {
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
  fbclid: null,
  gclid: null,
  gbraid: null,
  wbraid: null,
};

let _state: TrackerState = {
  status: 'loading',
  siteToken: null,
  launchPublicId: null,
  pagePublicId: null,
  config: null,
  leadToken: null,
  leadPublicId: null,
  // INV-TRACKER-003: visitorId starts null; set only after consent check in init()
  visitorId: null,
  attributionParams: { ...DEFAULT_ATTRIBUTION },
  platformCookies: { ...DEFAULT_PLATFORM_COOKIES },
  consent: { ...DEFAULT_CONSENT },
};

export function getState(): Readonly<TrackerState> {
  return _state;
}

export function setState(patch: Partial<TrackerState>): void {
  _state = { ..._state, ...patch };
}

export function transition(to: TrackerStatus): void {
  const from = _state.status;
  const valid =
    (from === 'loading' && to === 'initialized') ||
    (from === 'initialized' && (to === 'ready' || to === 'paused')) ||
    (from === 'ready' && to === 'paused') ||
    // Allow re-entry for idempotent transitions (e.g., repeated init guard)
    from === to;

  if (!valid) {
    // Fail silently — INV-TRACKER-007: tracker must not throw on the host page
    return;
  }
  _state = { ..._state, status: to };
}

export function setConfig(config: TrackerConfig | null): void {
  _state = { ..._state, config };
}

export function setLeadToken(token: string | null): void {
  _state = { ..._state, leadToken: token };
}

export function setLeadPublicId(publicId: string | null): void {
  _state = { ..._state, leadPublicId: publicId };
}

export function setPlatformCookies(cookies: PlatformCookies): void {
  _state = { ..._state, platformCookies: cookies };
}

export function setAttribution(params: AttributionParams): void {
  _state = { ..._state, attributionParams: params };
}

export function setConsent(consent: ConsentSnapshot): void {
  _state = { ..._state, consent };
}

export function setVisitorId(visitorId: string | null): void {
  // INV-TRACKER-003: only called after consent check; value may be null if consent denied
  _state = { ..._state, visitorId };
}
