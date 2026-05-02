/**
 * Attribution param persistence in localStorage.
 *
 * Persists UTM params + click IDs so they can be replayed in /v1/lead submissions
 * even after navigation or SPA route changes.
 *
 * BR-CONSENT-004: localStorage is not a cookie — no consent gate for attribution params.
 * These are functional/analytics params captured from the URL on landing.
 */

import type { AttributionParams } from './types';

export const ATTRIBUTION_KEY = '__funil_attr';

const TRACKED_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
] as const;

type TrackedParam = (typeof TRACKED_PARAMS)[number];

/**
 * Parse attribution params from a URL search string.
 * Exported for unit testing.
 */
export function parseAttributionFromSearch(
  search: string,
): Partial<AttributionParams> {
  const params: Partial<AttributionParams> = {};
  try {
    const sp = new URLSearchParams(search);
    for (const key of TRACKED_PARAMS) {
      const val = sp.get(key);
      if (val !== null) {
        (params as Record<TrackedParam, string | null>)[key] = val;
      }
    }
  } catch {
    // INV-TRACKER-007: fail silently
  }
  return params;
}

/**
 * Load attribution params from localStorage.
 * Returns null if nothing stored or localStorage unavailable.
 */
export function loadAttribution(): AttributionParams | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(ATTRIBUTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AttributionParams>;
    return mergeAttribution({}, parsed);
  } catch {
    // INV-TRACKER-007: fail silently
    return null;
  }
}

/**
 * Save attribution params to localStorage.
 * Does not overwrite existing values with nulls — first touch wins per session.
 */
export function saveAttribution(params: AttributionParams): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(params));
  } catch {
    // INV-TRACKER-007: fail silently (e.g., private browsing quota)
  }
}

/**
 * Build full AttributionParams from URL and existing storage.
 * First-touch wins: existing stored values are NOT overwritten by null URL params.
 */
export function mergeAttribution(
  stored: Partial<AttributionParams>,
  fromUrl: Partial<AttributionParams>,
): AttributionParams {
  const resolve = (key: TrackedParam): string | null => {
    // URL params take precedence on fresh navigation; fall back to stored.
    const urlVal = fromUrl[key] ?? null;
    const storedVal = stored[key] ?? null;
    return urlVal ?? storedVal;
  };

  return {
    utm_source: resolve('utm_source'),
    utm_medium: resolve('utm_medium'),
    utm_campaign: resolve('utm_campaign'),
    utm_content: resolve('utm_content'),
    utm_term: resolve('utm_term'),
    fbclid: resolve('fbclid'),
    gclid: resolve('gclid'),
    gbraid: resolve('gbraid'),
    wbraid: resolve('wbraid'),
  };
}

/**
 * Capture attribution from current URL and merge with stored.
 * Returns the merged result and persists it.
 */
export function captureAndPersistAttribution(): AttributionParams {
  try {
    const fromUrl = parseAttributionFromSearch(
      typeof location !== 'undefined' ? location.search : '',
    );
    const stored = loadAttribution() ?? {};
    const merged = mergeAttribution(stored, fromUrl);
    // Only save if URL has any new params to avoid noisy writes
    const hasUrlParams = TRACKED_PARAMS.some((k) => fromUrl[k] != null);
    if (hasUrlParams || !loadAttribution()) {
      saveAttribution(merged);
    }
    return merged;
  } catch {
    // INV-TRACKER-007: fail silently
    return {
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
  }
}

/**
 * Clear attribution from localStorage.
 * Called by Funil.logout() to clean up session data.
 */
export function clearAttribution(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(ATTRIBUTION_KEY);
    }
  } catch {
    // INV-TRACKER-007: fail silently
  }
}
