/**
 * Unit tests for the GA4 Measurement Protocol dispatcher.
 *
 * Covers:
 *   T-4-004 — client-id-resolver.ts (resolveClientId)
 *   T-4-004 — eligibility.ts (checkEligibility)
 *   T-4-004 — mapper.ts (mapEventToGa4Payload)
 *   T-4-004 — client.ts (sendToGa4, classifyGa4Error)
 *
 * BRs tested:
 *   BR-DISPATCH-001: idempotency_key uses measurement_id (ADR-013)
 *   BR-DISPATCH-003: retry/permanent classification
 *   BR-DISPATCH-004: skip_reason present when ineligible
 *   BR-CONSENT-003: analytics consent blocks GA4 dispatch
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type Ga4Config,
  type Ga4DispatchableEvent,
  type Ga4DispatchableLead,
  type Ga4EligibilityEvent,
  type Ga4MpPayload,
  type Ga4Result,
  checkEligibility,
  classifyGa4Error,
  mapEventToGa4Payload,
  resolveClientId,
  sendToGa4,
} from '../../../apps/edge/src/dispatchers/ga4-mp/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date('2024-05-02T00:00:00.000Z');
const FIXED_UNIX_SECONDS = Math.floor(FIXED_DATE.getTime() / 1000); // 1714608000
const FIXED_MICROS = FIXED_UNIX_SECONDS * 1_000_000; // 1714608000000000

function makeEvent(
  overrides: Partial<Ga4DispatchableEvent> = {},
): Ga4DispatchableEvent {
  return {
    event_id: 'evt_01HXK2N3P4QR5ST6UV7WX8YZ90',
    event_name: 'Purchase',
    event_time: FIXED_DATE,
    lead_id: 'lead-uuid-001',
    workspace_id: 'ws-uuid-001',
    user_data: {
      client_id_ga4: 'GA1.1.12345678.1234567890',
      session_id_ga4: 'session_abc123',
    },
    custom_data: {
      value: 197.0,
      currency: 'BRL',
      order_id: 'ORD-2024-001',
    },
    consent_snapshot: {
      analytics: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
    },
    ...overrides,
  };
}

function makeLead(
  overrides: Partial<Ga4DispatchableLead> = {},
): Ga4DispatchableLead {
  return {
    public_id: 'lead_pub_01HXK2N3P4QR5ST6UV7WX8YZ90',
    external_id_hash: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Ga4Config> = {}): Ga4Config {
  return {
    measurementId: 'G-ABCDE12345',
    apiSecret: 'secret-abc123',
    ...overrides,
  };
}

function makeEligibilityEvent(
  overrides: Partial<Ga4EligibilityEvent> = {},
): Ga4EligibilityEvent {
  return {
    consent_snapshot: { analytics: 'granted' },
    user_data: { client_id_ga4: 'GA1.1.12345678.1234567890' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: mock fetch
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown = {}): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

// ---------------------------------------------------------------------------
// resolveClientId
// ---------------------------------------------------------------------------

describe('resolveClientId', () => {
  it('returns client_id_ga4 when present (_ga cookie extracted by tracker.js)', () => {
    const result = resolveClientId({
      client_id_ga4: 'GA1.1.12345678.1234567890',
    });
    expect(result).toBe('GA1.1.12345678.1234567890');
  });

  it('returns null when user_data is null', () => {
    expect(resolveClientId(null)).toBeNull();
  });

  it('returns null when user_data is undefined', () => {
    expect(resolveClientId(undefined)).toBeNull();
  });

  it('mints GA4-compatible client_id from fvid when _ga absent', () => {
    // fvid with exactly 18+ chars
    const result = resolveClientId({ fvid: 'abcdefgh1234567890' });
    // Expected: GA1.1.<fvid[0..8]>.<fvid[8..18]>
    expect(result).toBe('GA1.1.abcdefgh.1234567890');
  });

  it('pads fvid with zeros if shorter than 18 chars', () => {
    // fvid = '1234' → padded to '123400000000000000'
    const result = resolveClientId({ fvid: '1234' });
    expect(result).toBe('GA1.1.12340000.0000000000');
  });

  it('minted client_id starts with GA1.1. prefix', () => {
    const result = resolveClientId({ fvid: 'xyz00000000000000000' });
    expect(result).toMatch(/^GA1\.1\./);
  });

  it('returns null when neither client_id_ga4 nor fvid present', () => {
    expect(resolveClientId({})).toBeNull();
  });

  it('returns null when client_id_ga4 is null and fvid is null', () => {
    expect(resolveClientId({ client_id_ga4: null, fvid: null })).toBeNull();
  });

  it('prefers client_id_ga4 over fvid when both present', () => {
    const result = resolveClientId({
      client_id_ga4: 'GA1.1.from_cookie.1234567890',
      fvid: 'somevisitorid00',
    });
    expect(result).toBe('GA1.1.from_cookie.1234567890');
  });
});

// ---------------------------------------------------------------------------
// checkEligibility
// ---------------------------------------------------------------------------

describe('checkEligibility', () => {
  it('eligible when all conditions are met', () => {
    const result = checkEligibility(makeEligibilityEvent(), {
      measurementId: 'G-ABCDE12345',
      apiSecret: 'secret',
    });
    expect(result.eligible).toBe(true);
  });

  it('BR-DISPATCH-004: not eligible when measurementId missing — reason: integration_not_configured', () => {
    const result = checkEligibility(makeEligibilityEvent(), {
      measurementId: null,
      apiSecret: 'secret',
    });
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });

  it('BR-DISPATCH-004: not eligible when config is null — reason: integration_not_configured', () => {
    const result = checkEligibility(makeEligibilityEvent(), null);
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });

  it('BR-DISPATCH-004: not eligible when config is undefined — reason: integration_not_configured', () => {
    const result = checkEligibility(makeEligibilityEvent(), undefined);
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });

  it('BR-CONSENT-003: not eligible when analytics=denied — reason: consent_denied:analytics', () => {
    const result = checkEligibility(
      makeEligibilityEvent({
        consent_snapshot: { analytics: 'denied' },
      }),
      { measurementId: 'G-ABCDE12345', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:analytics');
  });

  it('BR-CONSENT-003: not eligible when analytics=unknown — reason: consent_denied:analytics', () => {
    const result = checkEligibility(
      makeEligibilityEvent({
        consent_snapshot: { analytics: 'unknown' },
      }),
      { measurementId: 'G-ABCDE12345', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:analytics');
  });

  it('BR-CONSENT-003: not eligible when consent_snapshot is null — reason: consent_denied:analytics', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ consent_snapshot: null }),
      { measurementId: 'G-ABCDE12345', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:analytics');
  });

  it('not eligible when no client_id derivable — reason: no_client_id', () => {
    const result = checkEligibility(makeEligibilityEvent({ user_data: null }), {
      measurementId: 'G-ABCDE12345',
      apiSecret: 'secret',
    });
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    // OQ-012 OPEN: checkout direct without tracker
    expect(result.reason).toBe('no_client_id');
  });

  it('not eligible when user_data has no client_id fields — reason: no_client_id', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ user_data: { client_id_ga4: null, fvid: null } }),
      { measurementId: 'G-ABCDE12345', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_client_id');
  });

  it('eligible when client_id derivable from fvid (no _ga cookie)', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ user_data: { fvid: 'abcdefgh1234567890' } }),
      { measurementId: 'G-ABCDE12345', apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(true);
  });

  it('checks measurementId before consent (fail-fast ordering)', () => {
    // Both integration_not_configured and consent_denied apply — measurementId wins.
    const result = checkEligibility(
      makeEligibilityEvent({ consent_snapshot: { analytics: 'denied' } }),
      { measurementId: null, apiSecret: 'secret' },
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });
});

// ---------------------------------------------------------------------------
// mapEventToGa4Payload
// ---------------------------------------------------------------------------

describe('mapEventToGa4Payload', () => {
  it('maps Purchase to "purchase" GA4 event name', () => {
    const payload = mapEventToGa4Payload(makeEvent(), makeLead());
    expect(payload).not.toBeNull();
    expect(payload.events[0]?.name).toBe('purchase');
  });

  it('maps Lead to "generate_lead"', () => {
    const payload = mapEventToGa4Payload(
      makeEvent({ event_name: 'Lead' }),
      null,
    );
    expect(payload).not.toBeNull();
    expect(payload.events[0]?.name).toBe('generate_lead');
  });

  it('maps InitiateCheckout to "begin_checkout"', () => {
    const payload = mapEventToGa4Payload(
      makeEvent({ event_name: 'InitiateCheckout' }),
      null,
    );
    expect(payload).not.toBeNull();
    expect(payload.events[0]?.name).toBe('begin_checkout');
  });

  it('maps PageView to "page_view"', () => {
    const payload = mapEventToGa4Payload(
      makeEvent({ event_name: 'PageView' }),
      null,
    );
    expect(payload).not.toBeNull();
    expect(payload.events[0]?.name).toBe('page_view');
  });

  it('maps CompleteRegistration to "sign_up"', () => {
    const payload = mapEventToGa4Payload(
      makeEvent({ event_name: 'CompleteRegistration' }),
      null,
    );
    expect(payload).not.toBeNull();
    expect(payload.events[0]?.name).toBe('sign_up');
  });

  it('returns null for Subscribe (no GA4 equivalent)', () => {
    const payload = mapEventToGa4Payload(
      makeEvent({ event_name: 'Subscribe' }),
      null,
    );
    expect(payload).toBeNull();
  });

  it('returns null for StartTrial (no GA4 equivalent)', () => {
    const payload = mapEventToGa4Payload(
      makeEvent({ event_name: 'StartTrial' }),
      null,
    );
    expect(payload).toBeNull();
  });

  it('passes through unknown event names as custom events (not in no-equivalent list)', () => {
    const payload = mapEventToGa4Payload(
      makeEvent({ event_name: 'MyCustomEvent' }),
      null,
    );
    expect(payload).not.toBeNull();
    expect(payload.events[0]?.name).toBe('MyCustomEvent');
  });

  it('sets client_id from user_data.client_id_ga4', () => {
    const payload = mapEventToGa4Payload(makeEvent(), makeLead());
    expect(payload).not.toBeNull();
    expect(payload.client_id).toBe('GA1.1.12345678.1234567890');
  });

  it('sets user_id from lead.public_id', () => {
    const payload = mapEventToGa4Payload(makeEvent(), makeLead());
    expect(payload).not.toBeNull();
    expect(payload.user_id).toBe('lead_pub_01HXK2N3P4QR5ST6UV7WX8YZ90');
  });

  it('falls back to external_id_hash when public_id absent', () => {
    const lead = makeLead({ public_id: null, external_id_hash: 'hash_abc123' });
    const payload = mapEventToGa4Payload(makeEvent(), lead);
    expect(payload).not.toBeNull();
    expect(payload.user_id).toBe('hash_abc123');
  });

  it('omits user_id when lead is null', () => {
    const payload = mapEventToGa4Payload(makeEvent(), null);
    expect(payload).not.toBeNull();
    expect(payload.user_id).toBeUndefined();
  });

  it('sets timestamp_micros from event_time Date', () => {
    const payload = mapEventToGa4Payload(makeEvent(), makeLead());
    expect(payload).not.toBeNull();
    expect(payload.timestamp_micros).toBe(FIXED_MICROS);
  });

  it('sets timestamp_micros from event_time ISO string', () => {
    const payload = mapEventToGa4Payload(
      makeEvent({ event_time: '2024-05-02T00:00:00.000Z' }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload.timestamp_micros).toBe(FIXED_MICROS);
  });

  it('sets timestamp_micros from event_time Unix seconds number', () => {
    const payload = mapEventToGa4Payload(
      makeEvent({ event_time: FIXED_UNIX_SECONDS }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload.timestamp_micros).toBe(FIXED_MICROS);
  });

  it('Purchase params include value, currency, transaction_id', () => {
    const payload = mapEventToGa4Payload(makeEvent(), makeLead());
    expect(payload).not.toBeNull();
    const params = payload.events[0]?.params;
    expect(params?.value).toBe(197.0);
    expect(params?.currency).toBe('BRL');
    expect(params?.transaction_id).toBe('ORD-2024-001');
  });

  it('includes session_id from user_data.session_id_ga4', () => {
    const payload = mapEventToGa4Payload(makeEvent(), makeLead());
    expect(payload).not.toBeNull();
    expect(payload.events[0]?.params?.session_id).toBe('session_abc123');
  });

  it('omits session_id when user_data.session_id_ga4 absent', () => {
    const payload = mapEventToGa4Payload(
      makeEvent({ user_data: { client_id_ga4: 'GA1.1.x.y' } }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload.events[0]?.params?.session_id).toBeUndefined();
  });

  it('BR-CONSENT-003: consent object contains ad_user_data and ad_personalization', () => {
    const payload = mapEventToGa4Payload(makeEvent(), makeLead());
    expect(payload).not.toBeNull();
    expect(payload.consent?.ad_user_data).toBe('granted');
    expect(payload.consent?.ad_personalization).toBe('granted');
  });

  it('omits consent when consent_snapshot is null', () => {
    const payload = mapEventToGa4Payload(
      makeEvent({ consent_snapshot: null }),
      makeLead(),
    );
    expect(payload).not.toBeNull();
    expect(payload.consent).toBeUndefined();
  });

  it('builds correct payload matching Purchase fixture', () => {
    const payload = mapEventToGa4Payload(makeEvent(), makeLead());
    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({
      client_id: 'GA1.1.12345678.1234567890',
      user_id: 'lead_pub_01HXK2N3P4QR5ST6UV7WX8YZ90',
      timestamp_micros: FIXED_MICROS,
      events: [
        {
          name: 'purchase',
          params: {
            value: 197.0,
            currency: 'BRL',
            transaction_id: 'ORD-2024-001',
            session_id: 'session_abc123',
          },
        },
      ],
      consent: {
        ad_user_data: 'granted',
        ad_personalization: 'granted',
      },
    });
  });

  // T-14-013 — Guru amount fallback + items + transaction_id event_id fallback
  describe('T-14-013 — Guru Purchase enrichments', () => {
    it('reads cd.amount as value when cd.value absent (Guru shape)', () => {
      const payload = mapEventToGa4Payload(
        makeEvent({
          custom_data: { amount: 497.0, currency: 'BRL', product_id: 'abc123' },
        }),
        makeLead(),
      );
      expect(payload).not.toBeNull();
      expect(payload.events[0]?.params?.value).toBe(497.0);
    });

    it('prefers cd.value over cd.amount when both present', () => {
      const payload = mapEventToGa4Payload(
        makeEvent({
          custom_data: { value: 100.0, amount: 200.0, currency: 'BRL' },
        }),
        makeLead(),
      );
      expect(payload).not.toBeNull();
      expect(payload.events[0]?.params?.value).toBe(100.0);
    });

    it('populates items array for Purchase when product_id and product_name present', () => {
      const payload = mapEventToGa4Payload(
        makeEvent({
          custom_data: {
            amount: 497.0,
            currency: 'BRL',
            product_id: 'abc123',
            product_name: 'Workshop de Marketing',
          },
        }),
        makeLead(),
      );
      expect(payload).not.toBeNull();
      const params = payload.events[0]?.params;
      expect(params?.items).toHaveLength(1);
      expect(params?.items?.[0]).toEqual({
        item_id: 'abc123',
        item_name: 'Workshop de Marketing',
        price: 497.0,
        quantity: 1,
      });
    });

    it('populates items with only item_id when product_name absent', () => {
      const payload = mapEventToGa4Payload(
        makeEvent({
          custom_data: { amount: 497.0, currency: 'BRL', product_id: 'abc123' },
        }),
        makeLead(),
      );
      expect(payload).not.toBeNull();
      const item = payload.events[0]?.params?.items?.[0];
      expect(item?.item_id).toBe('abc123');
      expect(item?.item_name).toBeUndefined();
      expect(item?.quantity).toBe(1);
    });

    it('omits items when neither product_id nor product_name present', () => {
      const payload = mapEventToGa4Payload(
        makeEvent({ custom_data: { amount: 497.0, currency: 'BRL' } }),
        makeLead(),
      );
      expect(payload).not.toBeNull();
      expect(payload.events[0]?.params?.items).toBeUndefined();
    });

    it('omits items for non-Purchase events even when product_id present', () => {
      const payload = mapEventToGa4Payload(
        makeEvent({
          event_name: 'ViewContent',
          custom_data: { product_id: 'abc123', product_name: 'Workshop' },
        }),
        makeLead(),
      );
      expect(payload).not.toBeNull();
      expect(payload.events[0]?.params?.items).toBeUndefined();
    });

    it('uses event_id as transaction_id when order_id absent on Purchase (Guru shape)', () => {
      const payload = mapEventToGa4Payload(
        makeEvent({
          event_id: 'evt_guru_fallback_id',
          custom_data: { amount: 497.0, currency: 'BRL', product_id: 'abc123' },
        }),
        makeLead(),
      );
      expect(payload).not.toBeNull();
      expect(payload.events[0]?.params?.transaction_id).toBe('evt_guru_fallback_id');
    });

    it('still uses order_id as transaction_id when present (takes precedence over event_id)', () => {
      const payload = mapEventToGa4Payload(
        makeEvent({
          event_id: 'evt_should_not_be_used',
          custom_data: { amount: 497.0, currency: 'BRL', order_id: 'ORD-XYZ' },
        }),
        makeLead(),
      );
      expect(payload).not.toBeNull();
      expect(payload.events[0]?.params?.transaction_id).toBe('ORD-XYZ');
    });

    it('Lead event with cd.amount populates value', () => {
      const payload = mapEventToGa4Payload(
        makeEvent({
          event_name: 'Lead',
          custom_data: { amount: 50.0, currency: 'BRL' },
        }),
        makeLead(),
      );
      expect(payload).not.toBeNull();
      expect(payload.events[0]?.params?.value).toBe(50.0);
    });

    it('Lead event with no custom_data produces params without value (no crash)', () => {
      const payload = mapEventToGa4Payload(
        makeEvent({ event_name: 'Lead', custom_data: null }),
        makeLead(),
      );
      expect(payload).not.toBeNull();
      const params = payload.events[0]?.params;
      expect(params?.value).toBeUndefined();
      expect(params?.items).toBeUndefined();
    });

    it('full Guru Purchase scenario: amount+currency+product_id+product_name → all fields populated', () => {
      const payload = mapEventToGa4Payload(
        makeEvent({
          event_id: 'evt_guru_001',
          event_name: 'Purchase',
          custom_data: {
            amount: 497.0,
            currency: 'BRL',
            product_id: 'abc123',
            product_name: 'Workshop de Marketing',
            funnel_role: 'main',
          },
        }),
        makeLead(),
      );
      expect(payload).not.toBeNull();
      const params = payload.events[0]?.params;
      expect(params?.value).toBe(497.0);
      expect(params?.currency).toBe('BRL');
      expect(params?.transaction_id).toBe('evt_guru_001');
      expect(params?.items).toEqual([
        {
          item_id: 'abc123',
          item_name: 'Workshop de Marketing',
          price: 497.0,
          quantity: 1,
        },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// sendToGa4
// ---------------------------------------------------------------------------

describe('sendToGa4', () => {
  // Purchase always has a GA4 equivalent — mapEventToGa4Payload returns non-null here.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const dummyPayload = mapEventToGa4Payload(
    makeEvent(),
    makeLead(),
  ) as Ga4MpPayload;
  const config = makeConfig();

  it('returns ok:true on 204 No Content', async () => {
    const result = await sendToGa4(dummyPayload, config, mockFetch(204));
    expect(result.ok).toBe(true);
  });

  it('returns ok:true on 200 (debug mode)', async () => {
    const result = await sendToGa4(
      dummyPayload,
      config,
      mockFetch(200, { validationMessages: [] }),
    );
    expect(result.ok).toBe(true);
  });

  it('BR-DISPATCH-003: returns server_error on 500', async () => {
    const result = await sendToGa4(dummyPayload, config, mockFetch(500));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('server_error');
    if (result.kind !== 'server_error') return;
    expect(result.status).toBe(500);
  });

  it('BR-DISPATCH-003: returns server_error on 503', async () => {
    const result = await sendToGa4(dummyPayload, config, mockFetch(503));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('server_error');
  });

  it('BR-DISPATCH-003: returns server_error on network error (fetch throws)', async () => {
    const throwingFetch = vi
      .fn()
      .mockRejectedValue(new Error('network unreachable'));
    const result = await sendToGa4(
      dummyPayload,
      config,
      throwingFetch as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('server_error');
    if (result.kind !== 'server_error') return;
    expect(result.status).toBe(0);
  });

  it('BR-DISPATCH-003: returns permanent_failure on 400', async () => {
    const result = await sendToGa4(dummyPayload, config, mockFetch(400));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
  });

  it('BR-DISPATCH-003: returns permanent_failure on 401', async () => {
    const result = await sendToGa4(dummyPayload, config, mockFetch(401));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
  });

  it('BR-DISPATCH-003: returns permanent_failure on 403', async () => {
    const result = await sendToGa4(dummyPayload, config, mockFetch(403));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
  });

  it('URL includes measurement_id and api_secret as query params', async () => {
    const fetchSpy = mockFetch(204);
    await sendToGa4(dummyPayload, config, fetchSpy);
    const [url] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toContain('measurement_id=G-ABCDE12345');
    expect(url).toContain('api_secret=secret-abc123');
  });

  it('uses debug endpoint when debugMode=true', async () => {
    const fetchSpy = mockFetch(200, { validationMessages: [] });
    await sendToGa4(dummyPayload, { ...config, debugMode: true }, fetchSpy);
    const [url] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toContain('/debug/mp/collect');
  });

  it('uses production endpoint by default', async () => {
    const fetchSpy = mockFetch(204);
    await sendToGa4(dummyPayload, config, fetchSpy);
    const [url] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toContain('/mp/collect');
    expect(url).not.toContain('/debug/');
  });

  it('sends Content-Type: application/json header', async () => {
    const fetchSpy = mockFetch(204);
    await sendToGa4(dummyPayload, config, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
  });

  it('sends payload as JSON body', async () => {
    const fetchSpy = mockFetch(204);
    await sendToGa4(dummyPayload, config, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as Ga4MpPayload;
    expect(body.client_id).toBe(dummyPayload.client_id);
    expect(body.events[0]?.name).toBe('purchase');
  });
});

// ---------------------------------------------------------------------------
// classifyGa4Error
// ---------------------------------------------------------------------------

describe('classifyGa4Error', () => {
  it('BR-DISPATCH-003: server_error → retry', () => {
    const result: Extract<Ga4Result, { ok: false }> = {
      ok: false,
      kind: 'server_error',
      status: 500,
    };
    expect(classifyGa4Error(result)).toBe('retry');
  });

  it('BR-DISPATCH-003: server_error status 0 (network) → retry', () => {
    const result: Extract<Ga4Result, { ok: false }> = {
      ok: false,
      kind: 'server_error',
      status: 0,
    };
    expect(classifyGa4Error(result)).toBe('retry');
  });

  it('BR-DISPATCH-003: permanent_failure → permanent', () => {
    const result: Extract<Ga4Result, { ok: false }> = {
      ok: false,
      kind: 'permanent_failure',
      code: 'http_400',
    };
    expect(classifyGa4Error(result)).toBe('permanent');
  });
});
