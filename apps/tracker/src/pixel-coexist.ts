/**
 * Pixel coexistence helpers.
 *
 * INV-TRACKER-006: when pixel_policy = 'browser_and_server_managed', the
 * event_id sent to CAPI (server-side via /v1/events) MUST be identical to the
 * event_id used by the browser Pixel (FB Pixel / Google Tag).
 *
 * Mechanism:
 *   1. track() calls getOrCreateEventId(eventName) to obtain the event_id.
 *   2. The same id is written to window.__funil_event_id so that inline Pixel
 *      scripts (e.g. fbq('track', ..., {eventID: window.__funil_event_id})) can
 *      read it synchronously before the Pixel fires.
 *   3. The entry is stored in sessionStorage with a 5-minute TTL so that
 *      hot-reload / SPA navigation within the same session does not lose the id.
 *
 * Contract: docs/30-contracts/01-enums.md (PixelPolicy)
 * Contract: docs/30-contracts/05-api-server-actions.md (CONTRACT-api-events-v1)
 */

/** Storage key prefix in sessionStorage. */
const KEY_PREFIX = '__funil_eid_';

/** Window property read by inline Pixel scripts. */
const WINDOW_KEY = '__funil_event_id';

/** TTL for a stored event_id entry (5 minutes in ms). */
const TTL_MS = 5 * 60 * 1000;

interface StoredEntry {
  id: string;
  /** Unix timestamp (ms) when the entry expires. */
  expiresAt: number;
}

/**
 * Generate a new UUID-based event_id.
 * Falls back to a Math.random string when crypto.randomUUID is unavailable
 * (e.g., non-secure contexts in old browsers) — still unique enough for
 * dedup within a single browser session.
 *
 * INV-TRACKER-002: no external deps.
 */
function generateId(): string {
  try {
    if (
      typeof crypto !== 'undefined' &&
      typeof crypto.randomUUID === 'function'
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  // Fallback for non-secure contexts
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Read a stored entry from sessionStorage.
 * Returns null on any failure (INV-TRACKER-007: fail silently).
 */
function readEntry(eventName: string): StoredEntry | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(KEY_PREFIX + eventName);
    if (!raw) return null;
    const entry = JSON.parse(raw) as StoredEntry;
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      typeof entry.expiresAt !== 'number'
    ) {
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/**
 * Write an entry to sessionStorage.
 * Fails silently on quota errors or unavailability (INV-TRACKER-007).
 */
function writeEntry(eventName: string, entry: StoredEntry): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(KEY_PREFIX + eventName, JSON.stringify(entry));
  } catch {
    // INV-TRACKER-007: fail silently
  }
}

/**
 * Expose the event_id on window so inline Pixel snippets can read it.
 * INV-TRACKER-006: same event_id must flow to browser Pixel and CAPI server.
 */
function exposeOnWindow(id: string): void {
  try {
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>)[WINDOW_KEY] = id;
    }
  } catch {
    // INV-TRACKER-007: fail silently
  }
}

/**
 * Get or create an event_id for the given eventName.
 *
 * - If a non-expired entry exists in sessionStorage, reuse it (supports
 *   scenarios where Pixel fires slightly after track() call).
 * - Otherwise generate a new UUID, persist it, and expose on window.
 *
 * INV-TRACKER-006: ensures Pixel browser and CAPI server share the same id.
 *
 * @param eventName - canonical or custom event name (e.g. 'PageView')
 * @returns event_id string (UUID)
 */
export function getOrCreateEventId(eventName: string): string {
  try {
    const now = Date.now();
    const existing = readEntry(eventName);
    if (existing && existing.expiresAt > now) {
      exposeOnWindow(existing.id);
      return existing.id;
    }

    const id = generateId();
    writeEntry(eventName, { id, expiresAt: now + TTL_MS });
    exposeOnWindow(id);
    return id;
  } catch {
    // INV-TRACKER-007: fail silently — return a fresh id even if storage fails
    return generateId();
  }
}

/**
 * Forcefully create a new event_id for eventName, replacing any cached entry.
 * Called at the start of each track() invocation so that each distinct call
 * gets a fresh id (different PageView calls on different navigations differ).
 *
 * @param eventName - canonical or custom event name
 * @returns new event_id string
 */
export function createEventId(eventName: string): string {
  try {
    const id = generateId();
    writeEntry(eventName, { id, expiresAt: Date.now() + TTL_MS });
    exposeOnWindow(id);
    return id;
  } catch {
    // INV-TRACKER-007: fail silently
    return generateId();
  }
}

/** Exposed for tests — allows flushing a specific entry. */
export function _clearEventId(eventName: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(KEY_PREFIX + eventName);
    }
  } catch {
    // ignore
  }
}
