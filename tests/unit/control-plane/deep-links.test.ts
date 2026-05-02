/**
 * Unit tests — deep-links.ts pure URL builders
 *
 * All functions return HTTPS URLs that deep-link into external consoles.
 * Fallback to generic URL when ID is absent or empty.
 */

import { describe, expect, it } from 'vitest';
import {
  ga4DataStreams,
  ga4DebugView,
  ga4Realtime,
  googleAdsConversionDetail,
  googleAdsConversions,
  metaAEM,
  metaDomainVerification,
  metaEventsManager,
  metaTestEvents,
} from '../../../apps/control-plane/src/lib/deep-links.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isHttps(url: string): boolean {
  return url.startsWith('https://');
}

// ---------------------------------------------------------------------------
// metaEventsManager
// ---------------------------------------------------------------------------

describe('metaEventsManager', () => {
  it('includes pixelId in URL when provided', () => {
    const url = metaEventsManager('123456789');
    expect(url).toContain('123456789');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic URL (no ID in path) when pixelId is empty string', () => {
    const url = metaEventsManager('');
    expect(url).not.toContain('/pixel/');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic URL when pixelId is null', () => {
    const url = metaEventsManager(null);
    expect(url).not.toContain('/pixel/');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic URL when pixelId is undefined', () => {
    const url = metaEventsManager(undefined);
    expect(url).not.toContain('/pixel/');
    expect(isHttps(url)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// metaTestEvents
// ---------------------------------------------------------------------------

describe('metaTestEvents', () => {
  it('includes pixelId and /test_events path when ID provided', () => {
    const url = metaTestEvents('987654321');
    expect(url).toContain('987654321');
    expect(url).toContain('test_events');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic URL when pixelId absent', () => {
    const url = metaTestEvents(null);
    expect(url).not.toContain('test_events');
    expect(isHttps(url)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// metaDomainVerification
// ---------------------------------------------------------------------------

describe('metaDomainVerification', () => {
  it('returns valid HTTPS URL (no ID parameter needed)', () => {
    const url = metaDomainVerification();
    expect(isHttps(url)).toBe(true);
    expect(url.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// metaAEM
// ---------------------------------------------------------------------------

describe('metaAEM', () => {
  it('includes pixelId and /aem path when ID provided', () => {
    const url = metaAEM('111222333');
    expect(url).toContain('111222333');
    expect(url).toContain('/aem');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic fallback when pixelId is empty string', () => {
    const url = metaAEM('');
    expect(url).not.toContain('/aem');
    expect(isHttps(url)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ga4DebugView
// ---------------------------------------------------------------------------

describe('ga4DebugView', () => {
  it('returns URL with accountId and propertyId when both provided', () => {
    const url = ga4DebugView('123', '456');
    expect(url).toContain('a123');
    expect(url).toContain('p456');
    expect(url).toContain('debugView');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic fallback when accountId is null', () => {
    const url = ga4DebugView(null, '456');
    expect(url).not.toContain('debugView');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic fallback when propertyId is null', () => {
    const url = ga4DebugView('123', null);
    expect(url).not.toContain('debugView');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic fallback when both IDs are absent', () => {
    const url = ga4DebugView(undefined, undefined);
    expect(url).not.toContain('debugView');
    expect(isHttps(url)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ga4Realtime
// ---------------------------------------------------------------------------

describe('ga4Realtime', () => {
  it('includes propertyId and realtime path when ID provided', () => {
    const url = ga4Realtime('789012');
    expect(url).toContain('p789012');
    expect(url).toContain('realtime');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic fallback when propertyId is null', () => {
    const url = ga4Realtime(null);
    expect(url).not.toContain('realtime');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic fallback when propertyId is empty string', () => {
    const url = ga4Realtime('');
    expect(url).not.toContain('realtime');
    expect(isHttps(url)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ga4DataStreams
// ---------------------------------------------------------------------------

describe('ga4DataStreams', () => {
  it('returns URL with accountId, propertyId and /streams when both provided', () => {
    const url = ga4DataStreams('111', '222');
    expect(url).toContain('a111');
    expect(url).toContain('p222');
    expect(url).toContain('streams');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic fallback when accountId is missing', () => {
    const url = ga4DataStreams(null, '222');
    expect(url).not.toContain('streams');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic fallback when propertyId is missing', () => {
    const url = ga4DataStreams('111', null);
    expect(url).not.toContain('streams');
    expect(isHttps(url)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// googleAdsConversions
// ---------------------------------------------------------------------------

describe('googleAdsConversions', () => {
  it('returns valid HTTPS URL pointing to conversions', () => {
    const url = googleAdsConversions();
    expect(isHttps(url)).toBe(true);
    expect(url).toContain('conversions');
  });
});

// ---------------------------------------------------------------------------
// googleAdsConversionDetail
// ---------------------------------------------------------------------------

describe('googleAdsConversionDetail', () => {
  it('includes conversionId as query param when provided', () => {
    const url = googleAdsConversionDetail('conv-999');
    expect(url).toContain('conv-999');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic conversions URL when conversionId is null', () => {
    const url = googleAdsConversionDetail(null);
    expect(url).not.toContain('ocid=');
    expect(url).toContain('conversions');
    expect(isHttps(url)).toBe(true);
  });

  it('returns generic conversions URL when conversionId is empty string', () => {
    const url = googleAdsConversionDetail('');
    expect(url).not.toContain('ocid=');
    expect(isHttps(url)).toBe(true);
  });
});
