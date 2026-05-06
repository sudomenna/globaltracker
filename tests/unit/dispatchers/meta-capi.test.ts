/**
 * Unit tests for the Meta CAPI dispatcher.
 *
 * Covers:
 *   T-3-001 — mapper.ts (mapEventToMetaPayload)
 *   T-3-002 — client.ts (sendToMetaCapi, classifyMetaCapiError)
 *   T-3-003 — eligibility.ts (checkEligibility)
 *
 * BRs tested:
 *   BR-DISPATCH-001: event_id preserved; event_name translated correctly
 *   BR-DISPATCH-003: retry/permanent/skip classification
 *   BR-DISPATCH-004: skip_reason present when ineligible
 *   BR-CONSENT-003: consent check blocks dispatch when ad_user_data != granted
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type DispatchableEvent,
  type DispatchableLead,
  type EligibilityEvent,
  type EligibilityLead,
  type MetaCapiConfig,
  type MetaCapiResult,
  type MetaLaunchConfig,
  checkEligibility,
  classifyMetaCapiError,
  mapEventToMetaPayload,
  sendToMetaCapi,
} from '../../../apps/edge/src/dispatchers/meta-capi/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date('2024-05-02T00:00:00.000Z');
const FIXED_UNIX = Math.floor(FIXED_DATE.getTime() / 1000); // 1714608000

function makeEvent(
  overrides: Partial<DispatchableEvent> = {},
): DispatchableEvent {
  return {
    event_id: 'evt_01HXK2N3P4QR5ST6UV7WX8YZ90',
    event_name: 'Lead',
    event_time: FIXED_DATE,
    lead_id: 'lead-uuid-001',
    workspace_id: 'ws-uuid-001',
    user_data: {
      fbc: 'fb.1.1714608000000.AbCdEfGhIjKlMn',
      fbp: 'fb.1.1714600000000.1234567890',
      client_ip_address: '203.0.113.42',
      client_user_agent: 'Mozilla/5.0 Test',
    },
    ...overrides,
  };
}

function makeLead(overrides: Partial<DispatchableLead> = {}): DispatchableLead {
  return {
    email_hash_external:
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2',
    phone_hash_external:
      'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3',
    ...overrides,
  };
}

function makeLaunchConfig(pixelId = 'pixel-123'): MetaLaunchConfig {
  return { tracking: { meta: { pixel_id: pixelId } } };
}

function makeEligibilityEvent(
  overrides: Partial<EligibilityEvent> = {},
): EligibilityEvent {
  return {
    consent_snapshot: { ad_user_data: 'granted' },
    user_data: { fbc: 'fb.1.xxx', fbp: 'fb.1.yyy' },
    ...overrides,
  };
}

function makeEligibilityLead(
  overrides: Partial<EligibilityLead> = {},
): EligibilityLead {
  return {
    email_hash: 'abc123',
    phone_hash: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: mock fetch
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

// ---------------------------------------------------------------------------
// T-3-001 — mapper.ts
// ---------------------------------------------------------------------------

describe('mapEventToMetaPayload', () => {
  it('BR-DISPATCH-001: preserves event_id verbatim', () => {
    const payload = mapEventToMetaPayload(makeEvent(), makeLead());
    expect(payload.event_id).toBe('evt_01HXK2N3P4QR5ST6UV7WX8YZ90');
  });

  it('sets action_source to "website"', () => {
    const payload = mapEventToMetaPayload(makeEvent(), makeLead());
    expect(payload.action_source).toBe('website');
  });

  it('converts event_time Date to Unix seconds', () => {
    const payload = mapEventToMetaPayload(makeEvent(), makeLead());
    expect(payload.event_time).toBe(FIXED_UNIX);
  });

  it('converts event_time ISO string to Unix seconds', () => {
    const payload = mapEventToMetaPayload(
      makeEvent({ event_time: '2024-05-02T00:00:00.000Z' }),
      makeLead(),
    );
    expect(payload.event_time).toBe(FIXED_UNIX);
  });

  it('maps Lead event_name to "Lead"', () => {
    const payload = mapEventToMetaPayload(
      makeEvent({ event_name: 'Lead' }),
      null,
    );
    expect(payload.event_name).toBe('Lead');
  });

  it('maps Purchase event_name to "Purchase"', () => {
    const payload = mapEventToMetaPayload(
      makeEvent({ event_name: 'Purchase' }),
      null,
    );
    expect(payload.event_name).toBe('Purchase');
  });

  it('maps InitiateCheckout to "InitiateCheckout"', () => {
    const payload = mapEventToMetaPayload(
      makeEvent({ event_name: 'InitiateCheckout' }),
      null,
    );
    expect(payload.event_name).toBe('InitiateCheckout');
  });

  it('passes through unknown event names as-is', () => {
    const payload = mapEventToMetaPayload(
      makeEvent({ event_name: 'CustomMyEvent' }),
      null,
    );
    expect(payload.event_name).toBe('CustomMyEvent');
  });

  it('BR-CONSENT-003: includes em from lead.email_hash_external (no re-hashing)', () => {
    const lead = makeLead({ email_hash_external: 'deadbeef1234' });
    const payload = mapEventToMetaPayload(makeEvent(), lead);
    expect(payload.user_data.em).toBe('deadbeef1234');
  });

  it('BR-CONSENT-003: includes ph from lead.phone_hash_external (no re-hashing)', () => {
    const lead = makeLead({ phone_hash_external: 'cafebabe5678' });
    const payload = mapEventToMetaPayload(makeEvent(), lead);
    expect(payload.user_data.ph).toBe('cafebabe5678');
  });

  it('omits em when lead is null', () => {
    const payload = mapEventToMetaPayload(makeEvent(), null);
    expect(payload.user_data.em).toBeUndefined();
  });

  it('omits ph when lead.phone_hash_external is null', () => {
    const payload = mapEventToMetaPayload(
      makeEvent(),
      makeLead({ phone_hash_external: null }),
    );
    expect(payload.user_data.ph).toBeUndefined();
  });

  it('includes fbc from event.user_data (not hashed)', () => {
    const payload = mapEventToMetaPayload(makeEvent(), null);
    expect(payload.user_data.fbc).toBe('fb.1.1714608000000.AbCdEfGhIjKlMn');
  });

  it('includes fbp from event.user_data (not hashed)', () => {
    const payload = mapEventToMetaPayload(makeEvent(), null);
    expect(payload.user_data.fbp).toBe('fb.1.1714600000000.1234567890');
  });

  it('includes client_ip_address (not hashed)', () => {
    const payload = mapEventToMetaPayload(makeEvent(), null);
    expect(payload.user_data.client_ip_address).toBe('203.0.113.42');
  });

  it('includes client_user_agent (not hashed)', () => {
    const payload = mapEventToMetaPayload(makeEvent(), null);
    expect(payload.user_data.client_user_agent).toBe('Mozilla/5.0 Test');
  });

  it('builds custom_data for Purchase with value, currency, order_id', () => {
    const event = makeEvent({
      event_name: 'Purchase',
      custom_data: { value: 197.0, currency: 'BRL', order_id: 'ORD-001' },
    });
    const payload = mapEventToMetaPayload(event, null);
    expect(payload.custom_data).toEqual({
      value: 197.0,
      currency: 'BRL',
      order_id: 'ORD-001',
    });
  });

  it('omits custom_data when no relevant fields', () => {
    const payload = mapEventToMetaPayload(makeEvent({ custom_data: {} }), null);
    expect(payload.custom_data).toBeUndefined();
  });

  it('omits custom_data when custom_data is null', () => {
    const payload = mapEventToMetaPayload(
      makeEvent({ custom_data: null }),
      null,
    );
    expect(payload.custom_data).toBeUndefined();
  });

  it('includes test_event_code when provided in ctx', () => {
    const payload = mapEventToMetaPayload(makeEvent(), null, {
      testEventCode: 'TEST12345',
    });
    expect(payload.test_event_code).toBe('TEST12345');
  });

  it('omits test_event_code when not in ctx', () => {
    const payload = mapEventToMetaPayload(makeEvent(), null);
    expect(payload.test_event_code).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-3-002 — client.ts
// ---------------------------------------------------------------------------

describe('sendToMetaCapi', () => {
  const config: MetaCapiConfig = {
    pixelId: 'pixel-123',
    accessToken: 'token-abc',
  };

  const dummyPayload = mapEventToMetaPayload(makeEvent(), makeLead());

  it('returns ok:true with data on 2xx', async () => {
    const successBody = {
      events_received: 1,
      messages: [],
      fbtrace_id: 'trace-001',
    };
    const result = await sendToMetaCapi(
      dummyPayload,
      config,
      mockFetch(200, successBody),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.events_received).toBe(1);
    expect(result.data.fbtrace_id).toBe('trace-001');
  });

  it('returns rate_limit on 429', async () => {
    const result = await sendToMetaCapi(
      dummyPayload,
      config,
      mockFetch(429, { error: { message: 'rate limited', code: 4 } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rate_limit');
  });

  it('returns server_error on 500', async () => {
    const result = await sendToMetaCapi(
      dummyPayload,
      config,
      mockFetch(500, { error: { message: 'internal error' } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('server_error');
    if (result.kind !== 'server_error') return;
    expect(result.status).toBe(500);
  });

  it('returns server_error on 503', async () => {
    const result = await sendToMetaCapi(
      dummyPayload,
      config,
      mockFetch(503, { error: { message: 'unavailable' } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('server_error');
  });

  it('returns permanent_failure with invalid_pixel_id on 400 invalid_pixel_id', async () => {
    const result = await sendToMetaCapi(
      dummyPayload,
      config,
      mockFetch(400, {
        error: { code: 'invalid_pixel_id', message: 'bad pixel' },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
    if (result.kind !== 'permanent_failure') return;
    expect(result.code).toBe('invalid_pixel_id');
  });

  it('returns skip:no_user_data on 400 missing_required_user_data', async () => {
    const result = await sendToMetaCapi(
      dummyPayload,
      config,
      mockFetch(400, {
        error: {
          message:
            'missing_required_user_data: em or ph or external_id required',
          code: 100,
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('skip');
    if (result.kind !== 'skip') return;
    expect(result.reason).toBe('no_user_data');
  });

  it('returns permanent_failure on 403', async () => {
    const result = await sendToMetaCapi(
      dummyPayload,
      config,
      mockFetch(403, { error: { message: 'forbidden', code: 200 } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
  });

  it('returns permanent_failure on 422', async () => {
    const result = await sendToMetaCapi(
      dummyPayload,
      config,
      mockFetch(422, { error: { message: 'unprocessable', code: 100 } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
  });

  it('returns server_error on network error (fetch throws)', async () => {
    const throwingFetch = vi
      .fn()
      .mockRejectedValue(new Error('network unreachable'));
    const result = await sendToMetaCapi(
      dummyPayload,
      config,
      throwingFetch as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('server_error');
  });

  it('sends Authorization: Bearer header', async () => {
    const fetchSpy = mockFetch(200, {
      events_received: 1,
      messages: [],
      fbtrace_id: 'x',
    });
    await sendToMetaCapi(dummyPayload, config, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer token-abc',
    );
  });

  it('sends payload wrapped in { data: [payload] }', async () => {
    const fetchSpy = mockFetch(200, {
      events_received: 1,
      messages: [],
      fbtrace_id: 'x',
    });
    await sendToMetaCapi(dummyPayload, config, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(1);
  });

  it('URL includes pixelId', async () => {
    const fetchSpy = mockFetch(200, {
      events_received: 1,
      messages: [],
      fbtrace_id: 'x',
    });
    await sendToMetaCapi(
      dummyPayload,
      { ...config, pixelId: 'pxl-999' },
      fetchSpy,
    );
    const [url] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toContain('pxl-999');
  });
});

// ---------------------------------------------------------------------------
// T-3-002 — classifyMetaCapiError
// ---------------------------------------------------------------------------

describe('classifyMetaCapiError', () => {
  it('BR-DISPATCH-003: rate_limit → retry', () => {
    const result: Extract<MetaCapiResult, { ok: false }> = {
      ok: false,
      kind: 'rate_limit',
    };
    expect(classifyMetaCapiError(result)).toBe('retry');
  });

  it('BR-DISPATCH-003: server_error → retry', () => {
    const result: Extract<MetaCapiResult, { ok: false }> = {
      ok: false,
      kind: 'server_error',
      status: 500,
    };
    expect(classifyMetaCapiError(result)).toBe('retry');
  });

  it('BR-DISPATCH-003: permanent_failure → permanent', () => {
    const result: Extract<MetaCapiResult, { ok: false }> = {
      ok: false,
      kind: 'permanent_failure',
      code: 'invalid_pixel_id',
    };
    expect(classifyMetaCapiError(result)).toBe('permanent');
  });

  it('BR-DISPATCH-003: skip → skip', () => {
    const result: Extract<MetaCapiResult, { ok: false }> = {
      ok: false,
      kind: 'skip',
      reason: 'no_user_data',
    };
    expect(classifyMetaCapiError(result)).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// T-3-003 — eligibility.ts
// ---------------------------------------------------------------------------

describe('checkEligibility', () => {
  it('eligible when all conditions met', () => {
    const result = checkEligibility(
      makeEligibilityEvent(),
      makeEligibilityLead(),
      makeLaunchConfig(),
    );
    expect(result.eligible).toBe(true);
  });

  it('BR-DISPATCH-004: not eligible when pixel_id missing — reason: integration_not_configured', () => {
    const result = checkEligibility(
      makeEligibilityEvent(),
      makeEligibilityLead(),
      { tracking: { meta: { pixel_id: null } } },
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });

  it('BR-DISPATCH-004: not eligible when launchConfig is null — reason: integration_not_configured', () => {
    const result = checkEligibility(
      makeEligibilityEvent(),
      makeEligibilityLead(),
      null,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });

  it('BR-DISPATCH-004: not eligible when tracking.meta is null — reason: integration_not_configured', () => {
    const result = checkEligibility(
      makeEligibilityEvent(),
      makeEligibilityLead(),
      { tracking: { meta: null } },
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });

  it('BR-CONSENT-003: not eligible when ad_user_data=denied — reason: consent_denied:ad_user_data', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ consent_snapshot: { ad_user_data: 'denied' } }),
      makeEligibilityLead(),
      makeLaunchConfig(),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });

  it('BR-CONSENT-003: not eligible when ad_user_data=unknown — reason: consent_denied:ad_user_data', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ consent_snapshot: { ad_user_data: 'unknown' } }),
      makeEligibilityLead(),
      makeLaunchConfig(),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });

  it('BR-CONSENT-003: not eligible when consent_snapshot is null — reason: consent_denied:ad_user_data', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ consent_snapshot: null }),
      makeEligibilityLead(),
      makeLaunchConfig(),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });

  it('BR-DISPATCH-004: not eligible when no identity signal at all — reason: no_user_data', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ user_data: null }),
      makeEligibilityLead({ email_hash: null, phone_hash: null }),
      makeLaunchConfig(),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_user_data');
  });

  it('eligible when only email_hash present (no fbc/fbp)', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ user_data: null }),
      makeEligibilityLead({ email_hash: 'abc', phone_hash: null }),
      makeLaunchConfig(),
    );
    expect(result.eligible).toBe(true);
  });

  it('eligible when only fbc present (no email/phone hashes)', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ user_data: { fbc: 'fb.1.xxx' } }),
      makeEligibilityLead({ email_hash: null, phone_hash: null }),
      makeLaunchConfig(),
    );
    expect(result.eligible).toBe(true);
  });

  it('eligible when only fbp present (no email/phone hashes)', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ user_data: { fbp: 'fb.1.yyy' } }),
      makeEligibilityLead({ email_hash: null, phone_hash: null }),
      makeLaunchConfig(),
    );
    expect(result.eligible).toBe(true);
  });

  it('eligible when only phone_hash present', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ user_data: null }),
      makeEligibilityLead({ email_hash: null, phone_hash: 'def456' }),
      makeLaunchConfig(),
    );
    expect(result.eligible).toBe(true);
  });

  it('checks pixel_id before consent (fail-fast ordering)', () => {
    // Both integration_not_configured and consent_denied apply — pixel_id wins.
    const result = checkEligibility(
      makeEligibilityEvent({ consent_snapshot: { ad_user_data: 'denied' } }),
      makeEligibilityLead(),
      { tracking: { meta: { pixel_id: null } } },
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });
});
