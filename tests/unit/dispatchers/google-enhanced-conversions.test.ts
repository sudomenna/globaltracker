/**
 * Unit tests for the Google Ads Enhanced Conversions dispatcher.
 *
 * Covers:
 *   T-4-006 — mapper.ts (mapEventToEnhancedConversion)
 *   T-4-006 — eligibility.ts (checkEligibility)
 *   T-4-006 — client.ts (sendEnhancedConversion, classifyGoogleEnhancedError)
 *
 * BRs tested:
 *   BR-DISPATCH-001: idempotency subresource is conversion_action
 *   BR-DISPATCH-003: retry/permanent classification
 *   BR-DISPATCH-004: skip_reason present when ineligible
 *   BR-CONSENT-003: consent check blocks dispatch when ad_user_data != granted
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type DispatchableEvent,
  type DispatchableLead,
  type EligibilityEvent,
  type EligibilityLead,
  type EnhancedConversionsLaunchConfig,
  type GoogleAdsResult,
  checkEligibility,
  classifyGoogleEnhancedError,
  mapEventToEnhancedConversion,
  sendEnhancedConversion,
} from '../../../apps/edge/src/dispatchers/google-enhanced-conversions/index.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const FIXED_DATE = new Date('2024-05-02T12:30:00.000Z');
// Unix seconds for the fixed date
const FIXED_UNIX = Math.floor(FIXED_DATE.getTime() / 1000); // 1714650600

/** nowSeconds just inside the 24h window (1h after event). */
const NOW_WITHIN_WINDOW = FIXED_UNIX + 3600;
/** nowSeconds just outside the 24h window (25h after event). */
const NOW_OUTSIDE_WINDOW = FIXED_UNIX + 86_400 + 1;

function makeEvent(
  overrides: Partial<
    DispatchableEvent & EligibilityEvent & { event_name: string }
  > = {},
): DispatchableEvent & EligibilityEvent & { event_name: string } {
  return {
    event_id: 'evt_ENHANCED_001',
    event_name: 'Purchase',
    event_time: FIXED_DATE,
    lead_id: 'lead-uuid-001',
    workspace_id: 'ws-uuid-001',
    custom_data: { order_id: 'ORD-2024-001', value: 197.0, currency: 'BRL' },
    consent_snapshot: { ad_user_data: 'granted' },
    ...overrides,
  };
}

function makeLead(
  overrides: Partial<DispatchableLead & EligibilityLead> = {},
): DispatchableLead & EligibilityLead {
  return {
    // DispatchableLead fields (mapper) — SHA-256 puro externos
    email_hash_external:
      'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
    phone_hash_external:
      'b3a8e0e1f9ab1bfe3a36f231f676f78bb28a2d0b2a6f4e8f3d3f4a2e9c1d7b5e',
    // EligibilityLead fields — workspace-scoped hashes used for eligibility check
    email_hash:
      'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
    phone_hash:
      'b3a8e0e1f9ab1bfe3a36f231f676f78bb28a2d0b2a6f4e8f3d3f4a2e9c1d7b5e',
    ...overrides,
  };
}

function makeLaunchConfig(
  overrides: Partial<{
    conversion_action: string;
    ads_customer_id: string;
  }> = {},
): EnhancedConversionsLaunchConfig {
  return {
    tracking: {
      google: {
        ads_customer_id: overrides.ads_customer_id ?? '1234567890',
        conversion_actions: {
          Purchase:
            overrides.conversion_action ??
            'customers/1234567890/conversionActions/987654321',
        },
      },
    },
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
// checkEligibility — eligibility.ts
// ---------------------------------------------------------------------------

describe('checkEligibility (Enhanced Conversions)', () => {
  it('eligible when all conditions met', () => {
    const result = checkEligibility(
      makeEvent(),
      makeLead(),
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(true);
  });

  // --- BR-DISPATCH-004 / BR-CONSENT-003: consent ---

  it('BR-CONSENT-003: not eligible when ad_user_data=denied — reason: consent_denied:ad_user_data', () => {
    const result = checkEligibility(
      makeEvent({ consent_snapshot: { ad_user_data: 'denied' } }),
      makeLead(),
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });

  it('BR-CONSENT-003: not eligible when ad_user_data=unknown — reason: consent_denied:ad_user_data', () => {
    const result = checkEligibility(
      makeEvent({ consent_snapshot: { ad_user_data: 'unknown' } }),
      makeLead(),
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });

  it('BR-CONSENT-003: not eligible when consent_snapshot is null — reason: consent_denied:ad_user_data', () => {
    const result = checkEligibility(
      makeEvent({ consent_snapshot: null }),
      makeLead(),
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });

  // --- order_id ---

  it('BR-DISPATCH-004: not eligible without order_id — reason: no_order_id', () => {
    const result = checkEligibility(
      makeEvent({ custom_data: {} }),
      makeLead(),
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_order_id');
  });

  it('BR-DISPATCH-004: not eligible with empty order_id — reason: no_order_id', () => {
    const result = checkEligibility(
      makeEvent({ custom_data: { order_id: '   ' } }),
      makeLead(),
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_order_id');
  });

  it('BR-DISPATCH-004: not eligible when custom_data is null — reason: no_order_id', () => {
    const result = checkEligibility(
      makeEvent({ custom_data: null }),
      makeLead(),
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_order_id');
  });

  // --- user data ---

  it('BR-DISPATCH-004: not eligible without email_hash and phone_hash — reason: no_user_data', () => {
    const result = checkEligibility(
      makeEvent(),
      makeLead({ email_hash: null, phone_hash: null }),
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_user_data');
  });

  it('BR-DISPATCH-004: not eligible when lead is null — reason: no_user_data', () => {
    const result = checkEligibility(
      makeEvent(),
      null,
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_user_data');
  });

  it('eligible when only email_hash present (no phone)', () => {
    const result = checkEligibility(
      makeEvent(),
      makeLead({ phone_hash: null }),
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(true);
  });

  it('eligible when only phone_hash present (no email)', () => {
    const result = checkEligibility(
      makeEvent(),
      makeLead({ email_hash: null }),
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(true);
  });

  // --- conversion_action mapping ---

  it('BR-DISPATCH-004: not eligible when conversion_action not mapped — reason: no_conversion_action_mapped', () => {
    const result = checkEligibility(
      makeEvent({ event_name: 'UnmappedEvent' }),
      makeLead(),
      makeLaunchConfig(),
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_conversion_action_mapped');
  });

  it('BR-DISPATCH-004: not eligible when conversion_actions map is null — reason: no_conversion_action_mapped', () => {
    const config: EnhancedConversionsLaunchConfig = {
      tracking: {
        google: {
          ads_customer_id: '1234567890',
          conversion_actions: null,
        },
      },
    };
    const result = checkEligibility(
      makeEvent(),
      makeLead(),
      config,
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_conversion_action_mapped');
  });

  // --- adjustment window ---

  it('BR-DISPATCH-004: not eligible when event_time > 24h ago — reason: adjustment_window_expired', () => {
    const result = checkEligibility(
      makeEvent(),
      makeLead(),
      makeLaunchConfig(),
      NOW_OUTSIDE_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('adjustment_window_expired');
  });

  it('eligible when event_time is exactly within 24h window (nowSeconds injected)', () => {
    // nowSeconds = event_time + 1s (well within 24h)
    const result = checkEligibility(
      makeEvent(),
      makeLead(),
      makeLaunchConfig(),
      FIXED_UNIX + 1,
    );
    expect(result.eligible).toBe(true);
  });

  it('eligible at 23h59m59s elapsed (just inside window)', () => {
    const result = checkEligibility(
      makeEvent(),
      makeLead(),
      makeLaunchConfig(),
      FIXED_UNIX + 86_399,
    );
    expect(result.eligible).toBe(true);
  });

  it('not eligible at exactly 24h + 1s (just outside window)', () => {
    const result = checkEligibility(
      makeEvent(),
      makeLead(),
      makeLaunchConfig(),
      FIXED_UNIX + 86_401,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('adjustment_window_expired');
  });

  // --- integration_not_configured ---

  it('BR-DISPATCH-004: not eligible when ads_customer_id missing — reason: integration_not_configured', () => {
    const config: EnhancedConversionsLaunchConfig = {
      tracking: {
        google: {
          ads_customer_id: null,
          conversion_actions: { Purchase: 'customers/x/conversionActions/y' },
        },
      },
    };
    const result = checkEligibility(
      makeEvent(),
      makeLead(),
      config,
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });

  it('BR-DISPATCH-004: not eligible when launchConfig is null — reason: integration_not_configured', () => {
    const result = checkEligibility(
      makeEvent(),
      makeLead(),
      null,
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });

  // --- fail-fast ordering: integration_not_configured beats consent ---
  it('checks ads_customer_id before consent (fail-fast ordering)', () => {
    const result = checkEligibility(
      makeEvent({ consent_snapshot: { ad_user_data: 'denied' } }),
      makeLead(),
      null,
      NOW_WITHIN_WINDOW,
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });
});

// ---------------------------------------------------------------------------
// mapEventToEnhancedConversion — mapper.ts
// ---------------------------------------------------------------------------

describe('mapEventToEnhancedConversion', () => {
  it('adjustment_type is always ENHANCEMENT', () => {
    const payload = mapEventToEnhancedConversion(
      makeEvent(),
      makeLead(),
      makeLaunchConfig(),
    );
    expect(payload.adjustmentType).toBe('ENHANCEMENT');
  });

  it('order_id is present in payload from custom_data.order_id', () => {
    const payload = mapEventToEnhancedConversion(
      makeEvent(),
      makeLead(),
      makeLaunchConfig(),
    );
    expect(payload.orderId).toBe('ORD-2024-001');
  });

  it('sets correct conversionAction from launchConfig', () => {
    const payload = mapEventToEnhancedConversion(
      makeEvent(),
      makeLead(),
      makeLaunchConfig(),
    );
    expect(payload.conversionAction).toBe(
      'customers/1234567890/conversionActions/987654321',
    );
  });

  it('formats adjustmentDateTime as YYYY-MM-DD HH:MM:SS+00:00', () => {
    const payload = mapEventToEnhancedConversion(
      makeEvent({ event_time: new Date('2024-05-02T12:30:00.000Z') }),
      makeLead(),
      makeLaunchConfig(),
    );
    expect(payload.adjustmentDateTime).toBe('2024-05-02 12:30:00+00:00');
  });

  it('formats adjustmentDateTime from ISO string input', () => {
    const payload = mapEventToEnhancedConversion(
      makeEvent({ event_time: '2024-05-02T12:30:00.000Z' }),
      makeLead(),
      makeLaunchConfig(),
    );
    expect(payload.adjustmentDateTime).toBe('2024-05-02 12:30:00+00:00');
  });

  it('BR-CONSENT-003: includes hashedEmail from lead.email_hash_external (no re-hashing)', () => {
    const lead = makeLead({
      email_hash_external:
        'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
    });
    const payload = mapEventToEnhancedConversion(
      makeEvent(),
      lead,
      makeLaunchConfig(),
    );
    expect(payload.userIdentifiers).toContainEqual({
      hashedEmail:
        'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3',
    });
  });

  it('BR-CONSENT-003: includes hashedPhoneNumber from lead.phone_hash_external (no re-hashing)', () => {
    const lead = makeLead({
      phone_hash_external:
        'b3a8e0e1f9ab1bfe3a36f231f676f78bb28a2d0b2a6f4e8f3d3f4a2e9c1d7b5e',
    });
    const payload = mapEventToEnhancedConversion(
      makeEvent(),
      lead,
      makeLaunchConfig(),
    );
    expect(payload.userIdentifiers).toContainEqual({
      hashedPhoneNumber:
        'b3a8e0e1f9ab1bfe3a36f231f676f78bb28a2d0b2a6f4e8f3d3f4a2e9c1d7b5e',
    });
  });

  it('omits email identifier when lead.email_hash_external is null', () => {
    const lead = makeLead({ email_hash_external: null });
    const payload = mapEventToEnhancedConversion(
      makeEvent(),
      lead,
      makeLaunchConfig(),
    );
    const hasEmail = payload.userIdentifiers.some((id) => 'hashedEmail' in id);
    expect(hasEmail).toBe(false);
  });

  it('omits phone identifier when lead.phone_hash_external is null', () => {
    const lead = makeLead({ phone_hash_external: null });
    const payload = mapEventToEnhancedConversion(
      makeEvent(),
      lead,
      makeLaunchConfig(),
    );
    const hasPhone = payload.userIdentifiers.some(
      (id) => 'hashedPhoneNumber' in id,
    );
    expect(hasPhone).toBe(false);
  });

  it('produces empty userIdentifiers when lead is null', () => {
    const payload = mapEventToEnhancedConversion(
      makeEvent(),
      null,
      makeLaunchConfig(),
    );
    expect(payload.userIdentifiers).toHaveLength(0);
  });

  it('produces two userIdentifiers when both email_hash_external and phone_hash_external present', () => {
    const payload = mapEventToEnhancedConversion(
      makeEvent(),
      makeLead(),
      makeLaunchConfig(),
    );
    expect(payload.userIdentifiers).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// sendEnhancedConversion — client.ts
// ---------------------------------------------------------------------------

describe('sendEnhancedConversion', () => {
  const config = {
    customerId: '1234567890',
    developerToken: 'dev-token-abc',
    accessToken: 'access-token-xyz',
  };

  const dummyPayload = mapEventToEnhancedConversion(
    makeEvent(),
    makeLead(),
    makeLaunchConfig(),
  );

  it('returns ok:true on 2xx without partialFailureError', async () => {
    const result = await sendEnhancedConversion(
      dummyPayload,
      config,
      mockFetch(200, { results: [{}] }),
    );
    expect(result.ok).toBe(true);
  });

  it('BR-DISPATCH-003: returns rate_limit on HTTP 429', async () => {
    const result = await sendEnhancedConversion(
      dummyPayload,
      config,
      mockFetch(429, {}),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rate_limit');
  });

  it('BR-DISPATCH-003: returns server_error on HTTP 500', async () => {
    const result = await sendEnhancedConversion(
      dummyPayload,
      config,
      mockFetch(500, {}),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('server_error');
  });

  it('BR-DISPATCH-003: returns permanent_failure(order_id_not_found) on 400 INVALID_ARGUMENT with order_id error', async () => {
    const errorBody = {
      error: {
        code: 400,
        message: 'Request contains an invalid argument.',
        status: 'INVALID_ARGUMENT',
        details: [
          {
            errorCode: { conversionUploadError: 'ORDER_ID_NOT_FOUND' },
            message: 'order_id not found',
          },
        ],
      },
    };
    const result = await sendEnhancedConversion(
      dummyPayload,
      config,
      mockFetch(400, errorBody),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
    if (result.kind !== 'permanent_failure') return;
    expect(result.code).toBe('order_id_not_found');
  });

  it('BR-DISPATCH-003: returns permanent_failure on other 400', async () => {
    const result = await sendEnhancedConversion(
      dummyPayload,
      config,
      mockFetch(400, {
        error: {
          code: 400,
          message: 'bad request',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
  });

  it('returns server_error on network error (fetch throws)', async () => {
    const throwingFetch = vi
      .fn()
      .mockRejectedValue(new Error('network unreachable'));
    const result = await sendEnhancedConversion(
      dummyPayload,
      config,
      throwingFetch as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('server_error');
  });

  it('sends Authorization: Bearer header', async () => {
    const fetchSpy = mockFetch(200, { results: [{}] });
    await sendEnhancedConversion(dummyPayload, config, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer access-token-xyz',
    );
  });

  it('sends developer-token header', async () => {
    const fetchSpy = mockFetch(200, { results: [{}] });
    await sendEnhancedConversion(dummyPayload, config, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)['developer-token']).toBe(
      'dev-token-abc',
    );
  });

  it('URL includes customer_id', async () => {
    const fetchSpy = mockFetch(200, { results: [{}] });
    await sendEnhancedConversion(dummyPayload, config, fetchSpy);
    const [url] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toContain('1234567890');
    expect(url).toContain('conversionAdjustments:upload');
  });

  it('sends payload wrapped in { conversionAdjustments: [...], partialFailure: true }', async () => {
    const fetchSpy = mockFetch(200, { results: [{}] });
    await sendEnhancedConversion(dummyPayload, config, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as {
      conversionAdjustments: unknown[];
      partialFailure: boolean;
    };
    expect(Array.isArray(body.conversionAdjustments)).toBe(true);
    expect(body.conversionAdjustments).toHaveLength(1);
    expect(body.partialFailure).toBe(true);
  });

  it('returns permanent_failure on 2xx with partialFailureError', async () => {
    const result = await sendEnhancedConversion(
      dummyPayload,
      config,
      mockFetch(200, {
        partialFailureError: {
          code: 3,
          message: 'Some fields are invalid',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
  });
});

// ---------------------------------------------------------------------------
// classifyGoogleEnhancedError — client.ts
// ---------------------------------------------------------------------------

describe('classifyGoogleEnhancedError', () => {
  it('BR-DISPATCH-003: rate_limit → retry', () => {
    const result: Extract<GoogleAdsResult, { ok: false }> = {
      ok: false,
      kind: 'rate_limit',
    };
    expect(classifyGoogleEnhancedError(result)).toBe('retry');
  });

  it('BR-DISPATCH-003: server_error → retry', () => {
    const result: Extract<GoogleAdsResult, { ok: false }> = {
      ok: false,
      kind: 'server_error',
      status: 500,
    };
    expect(classifyGoogleEnhancedError(result)).toBe('retry');
  });

  it('BR-DISPATCH-003: permanent_failure(order_id_not_found) → permanent', () => {
    const result: Extract<GoogleAdsResult, { ok: false }> = {
      ok: false,
      kind: 'permanent_failure',
      code: 'order_id_not_found',
    };
    expect(classifyGoogleEnhancedError(result)).toBe('permanent');
  });

  it('BR-DISPATCH-003: permanent_failure(bad_request) → permanent', () => {
    const result: Extract<GoogleAdsResult, { ok: false }> = {
      ok: false,
      kind: 'permanent_failure',
      code: 'bad_request',
    };
    expect(classifyGoogleEnhancedError(result)).toBe('permanent');
  });
});
