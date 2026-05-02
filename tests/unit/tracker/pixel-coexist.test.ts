/**
 * Unit tests for apps/tracker/src/pixel-coexist.ts
 *
 * Covers:
 *   INV-TRACKER-006: when pixel_policy='browser_and_server_managed',
 *     the event_id used in the browser Pixel must be identical to the
 *     event_id sent to CAPI via /v1/events.
 *
 * Mechanism under test:
 *   - getOrCreateEventId() returns the same id within TTL.
 *   - getOrCreateEventId() returns a NEW id after TTL expires.
 *   - createEventId() always generates a fresh id (called per track() invocation).
 *   - The id is exposed on window.__funil_event_id so inline Pixel scripts read it.
 *   - Failure is silent — functions always return a string.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _clearEventId,
  createEventId,
  getOrCreateEventId,
} from '../../../apps/tracker/src/pixel-coexist';

const WINDOW_KEY = '__funil_event_id';

/** Simple in-memory sessionStorage mock. */
function makeSessionStorageMock() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete store[key];
    },
    clear: () => {
      for (const k of Object.keys(store)) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete store[k];
      }
    },
  };
}

describe('getOrCreateEventId', () => {
  let sessionStorageMock: ReturnType<typeof makeSessionStorageMock>;

  beforeEach(() => {
    sessionStorageMock = makeSessionStorageMock();
    vi.stubGlobal('sessionStorage', sessionStorageMock);
    vi.stubGlobal('window', {});
    vi.stubGlobal('crypto', {
      randomUUID: () =>
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a non-empty string', () => {
    const id = getOrCreateEventId('PageView');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns the SAME id when called again within TTL — INV-TRACKER-006', () => {
    const id1 = getOrCreateEventId('PageView');
    const id2 = getOrCreateEventId('PageView');
    // Within TTL (no time manipulation), should return the same id
    expect(id1).toBe(id2);
  });

  it('returns DIFFERENT ids for different event names', () => {
    const pageViewId = getOrCreateEventId('PageView');
    const leadId = getOrCreateEventId('Lead');
    // Different event names → independent entries
    expect(pageViewId).not.toBe(leadId);
  });

  it('returns a NEW id after TTL expires', () => {
    const id1 = getOrCreateEventId('PageView');

    // Simulate TTL expiry by advancing time past 5 minutes
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60 * 1000);

    const id2 = getOrCreateEventId('PageView');
    expect(id2).not.toBe(id1);

    vi.restoreAllMocks();
  });

  it('exposes the event_id on window.__funil_event_id — INV-TRACKER-006', () => {
    const id = getOrCreateEventId('PageView');
    expect((window as unknown as Record<string, unknown>)[WINDOW_KEY]).toBe(id);
  });

  it('updates window.__funil_event_id on each call within TTL', () => {
    const id1 = getOrCreateEventId('InitiateCheckout');
    expect((window as unknown as Record<string, unknown>)[WINDOW_KEY]).toBe(
      id1,
    );

    const id2 = getOrCreateEventId('InitiateCheckout');
    // Same id, but window should still be set
    expect((window as unknown as Record<string, unknown>)[WINDOW_KEY]).toBe(
      id2,
    );
    expect(id1).toBe(id2);
  });

  it('fails silently when sessionStorage is unavailable — INV-TRACKER-007', () => {
    vi.stubGlobal('sessionStorage', undefined);
    // Must not throw; returns a valid id
    expect(() => getOrCreateEventId('PageView')).not.toThrow();
    const id = getOrCreateEventId('PageView');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('fails silently when window is unavailable — INV-TRACKER-007', () => {
    vi.stubGlobal('window', undefined);
    expect(() => getOrCreateEventId('PageView')).not.toThrow();
    const id = getOrCreateEventId('PageView');
    expect(typeof id).toBe('string');
  });
});

describe('createEventId', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageMock());
    vi.stubGlobal('window', {});
    vi.stubGlobal('crypto', {
      randomUUID: () =>
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('always returns a fresh id, even when a cached entry exists', () => {
    const id1 = createEventId('PageView');
    const id2 = createEventId('PageView');
    // createEventId() replaces the entry every call → different ids
    expect(id1).not.toBe(id2);
  });

  it('exposes the new id on window.__funil_event_id immediately — INV-TRACKER-006', () => {
    const id = createEventId('Lead');
    expect((window as unknown as Record<string, unknown>)[WINDOW_KEY]).toBe(id);
  });

  it('the fresh id is then returned by getOrCreateEventId within TTL', () => {
    // After createEventId writes the new entry, getOrCreateEventId should reuse it
    const createdId = createEventId('Purchase');
    const gotId = getOrCreateEventId('Purchase');
    expect(gotId).toBe(createdId);
  });

  it('fails silently when sessionStorage is unavailable — INV-TRACKER-007', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(() => createEventId('PageView')).not.toThrow();
    const id = createEventId('PageView');
    expect(typeof id).toBe('string');
  });
});

describe('_clearEventId (test helper)', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', makeSessionStorageMock());
    vi.stubGlobal('window', {});
    vi.stubGlobal('crypto', {
      randomUUID: () =>
        'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes the cached entry so next getOrCreateEventId generates a new id', () => {
    const id1 = getOrCreateEventId('ViewContent');
    _clearEventId('ViewContent');
    const id2 = getOrCreateEventId('ViewContent');
    expect(id2).not.toBe(id1);
  });
});

describe('pixel coexist — INV-TRACKER-006 end-to-end scenario', () => {
  /**
   * Simulates the browser_and_server_managed flow:
   *   1. track() calls createEventId('PageView') → gets id_A, writes to window.__funil_event_id
   *   2. Inline Pixel snippet reads window.__funil_event_id → uses id_A for fbq('track', ...)
   *   3. sendEvent() is called with payload.event_id = id_A → CAPI receives id_A
   *   4. Meta deduplicates browser Pixel event and CAPI event via shared id_A.
   */
  it('window.__funil_event_id matches the id that would be sent to CAPI', () => {
    const mockWindow: Record<string, unknown> = {};
    vi.stubGlobal('window', mockWindow);
    vi.stubGlobal('sessionStorage', makeSessionStorageMock());
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn().mockReturnValue('fixed-uuid-for-test'),
    });

    // Step 1: tracker calls createEventId (what index.ts does for browser_and_server_managed)
    const eventId = createEventId('PageView');

    // Step 2: inline Pixel snippet reads window.__funil_event_id
    const pixelEventId = mockWindow[WINDOW_KEY];

    // Step 3: payload sent to CAPI uses eventId
    const capiEventId = eventId;

    // INV-TRACKER-006: all three must be identical
    expect(pixelEventId).toBe(eventId);
    expect(capiEventId).toBe(eventId);
    expect(pixelEventId).toBe(capiEventId);

    vi.unstubAllGlobals();
  });
});
