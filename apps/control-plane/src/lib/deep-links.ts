const META_BASE = 'https://business.facebook.com';
const GA4_BASE = 'https://analytics.google.com/analytics/web/#';
const GADS_BASE = 'https://ads.google.com/aw';

function isPresent(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.length > 0;
}

// Meta

export function metaEventsManager(pixelId: string | null | undefined): string {
  if (!isPresent(pixelId)) return `${META_BASE}/events_manager2`;
  return `${META_BASE}/events_manager2/list/pixel/${pixelId}`;
}

export function metaTestEvents(pixelId: string | null | undefined): string {
  if (!isPresent(pixelId)) return `${META_BASE}/events_manager2`;
  return `${META_BASE}/events_manager2/list/pixel/${pixelId}/test_events`;
}

export function metaDomainVerification(): string {
  return `${META_BASE}/settings/owned-domains`;
}

export function metaAEM(pixelId: string | null | undefined): string {
  if (!isPresent(pixelId)) return `${META_BASE}/events_manager2`;
  return `${META_BASE}/events_manager2/list/pixel/${pixelId}/aem`;
}

// GA4

export function ga4DebugView(
  accountId: string | null | undefined,
  propertyId: string | null | undefined,
): string {
  if (!isPresent(accountId) || !isPresent(propertyId)) {
    return `${GA4_BASE}/`;
  }
  return `${GA4_BASE}/a${accountId}p${propertyId}/admin/debugView`;
}

export function ga4Realtime(propertyId: string | null | undefined): string {
  if (!isPresent(propertyId)) return `${GA4_BASE}/`;
  return `${GA4_BASE}/p${propertyId}/realtime/overview`;
}

export function ga4DataStreams(
  accountId: string | null | undefined,
  propertyId: string | null | undefined,
): string {
  if (!isPresent(accountId) || !isPresent(propertyId)) {
    return `${GA4_BASE}/`;
  }
  return `${GA4_BASE}/a${accountId}p${propertyId}/admin/streams`;
}

// Google Ads

export function googleAdsConversions(): string {
  return `${GADS_BASE}/conversions`;
}

export function googleAdsConversionDetail(
  conversionId: string | null | undefined,
): string {
  if (!isPresent(conversionId)) return `${GADS_BASE}/conversions`;
  return `${GADS_BASE}/conversions/detail?ocid=${conversionId}`;
}
