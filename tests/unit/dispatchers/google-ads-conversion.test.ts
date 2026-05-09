/**
 * Unit tests for the Google Ads Conversion Upload dispatcher.
 *
 * Covers:
 *   T-4-005 — mapper.ts (mapEventToConversionUpload, formatConversionDateTime)
 *   T-4-005 — eligibility.ts (checkEligibility)
 *   T-4-005 — client.ts (sendConversionUpload, classifyGoogleAdsError)
 *   T-4-005 — oauth.ts (refreshAccessToken)
 *
 * BRs tested:
 *   BR-DISPATCH-001: conversion_action as destination_subresource
 *   BR-DISPATCH-003: retry/permanent classification
 *   BR-DISPATCH-004: skip_reason present when ineligible
 *   BR-CONSENT-003: consent check blocks dispatch when ad_user_data != granted
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type ConversionUploadEvent,
  type EligibilityEvent,
  type GoogleAdsConfig,
  type GoogleAdsEligibilityConfig,
  type GoogleAdsLaunchConfig,
  type GoogleAdsResult,
  checkEligibility,
  classifyGoogleAdsError,
  formatConversionDateTime,
  mapEventToConversionUpload,
  refreshAccessToken,
  sendConversionUpload,
} from '../../../apps/edge/src/dispatchers/google-ads-conversion/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_ISO = '2024-05-02T05:05:00.000Z';
const FIXED_DATE = new Date(FIXED_ISO);

const CUSTOMER_ID = '1234567890';
const CONVERSION_ACTION = 'customers/1234567890/conversionActions/987654321';

function makeEvent(
  overrides: Partial<ConversionUploadEvent> = {},
): ConversionUploadEvent {
  return {
    event_id: 'evt_01HXK2N3P4QR5ST6UV7WX8YZ90',
    event_name: 'Purchase',
    event_time: FIXED_DATE,
    workspace_id: 'ws-uuid-001',
    attribution: {
      gclid: 'TeSter-gclid-ABC123XYZabc456def789',
    },
    custom_data: {
      value: 197.0,
      currency: 'BRL',
      order_id: 'ORD-2024-00042',
    },
    ...overrides,
  };
}

function makeLaunchConfig(
  overrides: Partial<GoogleAdsLaunchConfig['tracking']> = {},
): GoogleAdsLaunchConfig {
  return {
    tracking: {
      google: {
        ads_customer_id: CUSTOMER_ID,
        conversion_actions: { Purchase: CONVERSION_ACTION },
        ...overrides.google,
      },
      ...overrides,
    },
  };
}

function makeEligibilityConfig(
  overrides: Partial<GoogleAdsEligibilityConfig['tracking']> = {},
): GoogleAdsEligibilityConfig {
  return {
    tracking: {
      google: {
        ads_customer_id: CUSTOMER_ID,
        conversion_actions: { Purchase: CONVERSION_ACTION },
        ...overrides.google,
      },
      ...overrides,
    },
  };
}

function makeEligibilityEvent(
  overrides: Partial<EligibilityEvent> = {},
): EligibilityEvent {
  return {
    event_name: 'Purchase',
    consent_snapshot: { ad_user_data: 'granted' },
    attribution: { gclid: 'TeSter-gclid-ABC123' },
    ...overrides,
  };
}

function makeGoogleAdsConfig(): GoogleAdsConfig {
  return {
    oauth: {
      clientId: 'client-id-001',
      clientSecret: 'client-secret-001',
      refreshToken: 'refresh-token-001',
    },
    developerToken: 'dev-token-001',
    customerId: CUSTOMER_ID,
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

/**
 * Creates a chained fetch mock: first call returns OAuth token response,
 * second call returns the API response. This simulates the real flow where
 * sendConversionUpload calls refreshAccessToken (which uses fetch) then the API.
 */
function mockFetchChain(
  oauthBody: unknown,
  apiStatus: number,
  apiBody: unknown,
): typeof fetch {
  return vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => oauthBody,
    } as Response)
    .mockResolvedValueOnce({
      ok: apiStatus >= 200 && apiStatus < 300,
      status: apiStatus,
      json: async () => apiBody,
    } as Response);
}

const OAUTH_SUCCESS = {
  access_token: 'ya29.access-token-mock',
  expires_in: 3599,
  token_type: 'Bearer',
};

// ---------------------------------------------------------------------------
// T-4-005 — formatConversionDateTime
// ---------------------------------------------------------------------------

describe('formatConversionDateTime', () => {
  it('formats Date to Google required format', () => {
    const result = formatConversionDateTime(FIXED_DATE);
    expect(result).toBe('2024-05-02 05:05:00+00:00');
  });

  it('formats ISO string to Google required format', () => {
    const result = formatConversionDateTime(FIXED_ISO);
    expect(result).toBe('2024-05-02 05:05:00+00:00');
  });

  it('pads month and day with leading zero', () => {
    const result = formatConversionDateTime(
      new Date('2024-01-05T03:07:09.000Z'),
    );
    expect(result).toBe('2024-01-05 03:07:09+00:00');
  });

  it('uses UTC time (not local timezone)', () => {
    // 2024-05-02T23:59:59Z should remain in UTC
    const result = formatConversionDateTime(
      new Date('2024-05-02T23:59:59.000Z'),
    );
    expect(result).toBe('2024-05-02 23:59:59+00:00');
  });
});

// ---------------------------------------------------------------------------
// T-4-005 — mapEventToConversionUpload
// ---------------------------------------------------------------------------

describe('mapEventToConversionUpload', () => {
  it('maps Purchase event with gclid correctly', () => {
    const payload = mapEventToConversionUpload(makeEvent(), makeLaunchConfig());
    expect(payload.conversion_action).toBe(CONVERSION_ACTION);
    expect(payload.conversion_date_time).toBe('2024-05-02 05:05:00+00:00');
    expect(payload.gclid).toBe('TeSter-gclid-ABC123XYZabc456def789');
    expect(payload.conversion_value).toBe(197.0);
    expect(payload.currency_code).toBe('BRL');
    expect(payload.order_id).toBe('ORD-2024-00042');
  });

  it('BR-DISPATCH-001: prioritizes gclid over gbraid', () => {
    const event = makeEvent({
      attribution: {
        gclid: 'gclid-priority',
        gbraid: 'gbraid-secondary',
      },
    });
    const payload = mapEventToConversionUpload(event, makeLaunchConfig());
    expect(payload.gclid).toBe('gclid-priority');
    expect(payload.gbraid).toBeUndefined();
    expect(payload.wbraid).toBeUndefined();
  });

  it('uses gbraid when gclid absent', () => {
    const event = makeEvent({
      attribution: {
        gclid: null,
        gbraid: 'gbraid-value',
        wbraid: 'wbraid-value',
      },
    });
    const payload = mapEventToConversionUpload(event, makeLaunchConfig());
    expect(payload.gclid).toBeUndefined();
    expect(payload.gbraid).toBe('gbraid-value');
    expect(payload.wbraid).toBeUndefined();
  });

  it('uses wbraid when gclid and gbraid absent', () => {
    const event = makeEvent({
      attribution: { gclid: null, gbraid: null, wbraid: 'wbraid-only' },
    });
    const payload = mapEventToConversionUpload(event, makeLaunchConfig());
    expect(payload.gclid).toBeUndefined();
    expect(payload.gbraid).toBeUndefined();
    expect(payload.wbraid).toBe('wbraid-only');
  });

  it('omits conversion_value when custom_data.value absent', () => {
    const event = makeEvent({ custom_data: { currency: 'BRL' } });
    const payload = mapEventToConversionUpload(event, makeLaunchConfig());
    expect(payload.conversion_value).toBeUndefined();
  });

  it('omits currency_code when custom_data.currency absent', () => {
    const event = makeEvent({ custom_data: { value: 197.0 } });
    const payload = mapEventToConversionUpload(event, makeLaunchConfig());
    expect(payload.currency_code).toBeUndefined();
  });

  it('omits order_id when custom_data.order_id absent', () => {
    const event = makeEvent({ custom_data: { value: 197.0, currency: 'BRL' } });
    const payload = mapEventToConversionUpload(event, makeLaunchConfig());
    expect(payload.order_id).toBeUndefined();
  });

  it('throws when conversion_action not mapped', () => {
    const config: GoogleAdsLaunchConfig = {
      tracking: {
        google: { ads_customer_id: CUSTOMER_ID, conversion_actions: {} },
      },
    };
    expect(() => mapEventToConversionUpload(makeEvent(), config)).toThrow(
      "no conversion_action mapped for event 'Purchase'",
    );
  });

  it('handles ISO string event_time', () => {
    const event = makeEvent({ event_time: FIXED_ISO });
    const payload = mapEventToConversionUpload(event, makeLaunchConfig());
    expect(payload.conversion_date_time).toBe('2024-05-02 05:05:00+00:00');
  });
});

// ---------------------------------------------------------------------------
// T-4-005 — checkEligibility
// ---------------------------------------------------------------------------

describe('checkEligibility', () => {
  it('eligible when all conditions met', () => {
    const result = checkEligibility(
      makeEligibilityEvent(),
      makeEligibilityConfig(),
    );
    expect(result.eligible).toBe(true);
  });

  it('BR-CONSENT-003: not eligible when ad_user_data=denied — reason: consent_denied:ad_user_data', () => {
    const result = checkEligibility(
      makeEligibilityEvent({
        consent_snapshot: { ad_user_data: 'denied' },
      }),
      makeEligibilityConfig(),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });

  it('BR-CONSENT-003: not eligible when ad_user_data=unknown — reason: consent_denied:ad_user_data', () => {
    const result = checkEligibility(
      makeEligibilityEvent({
        consent_snapshot: { ad_user_data: 'unknown' },
      }),
      makeEligibilityConfig(),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });

  it('BR-CONSENT-003: not eligible when consent_snapshot is null — reason: consent_denied:ad_user_data', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ consent_snapshot: null }),
      makeEligibilityConfig(),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });

  it('BR-DISPATCH-004: not eligible without gclid/gbraid/wbraid — reason: no_click_id_available', () => {
    const result = checkEligibility(
      makeEligibilityEvent({ attribution: null }),
      makeEligibilityConfig(),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_click_id_available');
  });

  it('BR-DISPATCH-004: not eligible when all click IDs are null/empty — reason: no_click_id_available', () => {
    const result = checkEligibility(
      makeEligibilityEvent({
        attribution: { gclid: null, gbraid: null, wbraid: null },
      }),
      makeEligibilityConfig(),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_click_id_available');
  });

  it('BR-DISPATCH-004: not eligible without conversion_action — reason: no_conversion_action_mapped', () => {
    const result = checkEligibility(
      makeEligibilityEvent(),
      makeEligibilityConfig({
        google: { ads_customer_id: CUSTOMER_ID, conversion_actions: {} },
      }),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('no_conversion_action_mapped');
  });

  it('BR-DISPATCH-004: not eligible without ads_customer_id — reason: integration_not_configured', () => {
    const result = checkEligibility(
      makeEligibilityEvent(),
      makeEligibilityConfig({
        google: {
          ads_customer_id: null,
          conversion_actions: { Purchase: CONVERSION_ACTION },
        },
      }),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('integration_not_configured');
  });

  it('BR-DISPATCH-004: not eligible when launchConfig is null — reason: no_conversion_action_mapped', () => {
    const result = checkEligibility(makeEligibilityEvent(), null);
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    // No config means conversion_action check fails first after click ID check
    expect(result.reason).toBe('no_conversion_action_mapped');
  });

  it('eligible with gbraid only (no gclid)', () => {
    const result = checkEligibility(
      makeEligibilityEvent({
        attribution: { gclid: null, gbraid: 'gbraid-value' },
      }),
      makeEligibilityConfig(),
    );
    expect(result.eligible).toBe(true);
  });

  it('eligible with wbraid only', () => {
    const result = checkEligibility(
      makeEligibilityEvent({
        attribution: { gclid: null, gbraid: null, wbraid: 'wbraid-value' },
      }),
      makeEligibilityConfig(),
    );
    expect(result.eligible).toBe(true);
  });

  it('checks consent before click ID (fail-fast ordering)', () => {
    // Both consent_denied and no_click_id_available apply — consent wins.
    const result = checkEligibility(
      makeEligibilityEvent({
        consent_snapshot: { ad_user_data: 'denied' },
        attribution: null,
      }),
      makeEligibilityConfig(),
    );
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.reason).toBe('consent_denied:ad_user_data');
  });
});

// ---------------------------------------------------------------------------
// T-4-005 — oauth.ts (refreshAccessToken)
// ---------------------------------------------------------------------------

describe('refreshAccessToken', () => {
  const config = {
    clientId: 'client-id-001',
    clientSecret: 'client-secret-001',
    refreshToken: 'refresh-token-001',
  };

  it('returns access_token on success', async () => {
    const fetchMock = mockFetch(200, OAUTH_SUCCESS);
    const token = await refreshAccessToken(config, fetchMock);
    expect(token).toBe('ya29.access-token-mock');
  });

  it('throws on non-2xx response', async () => {
    const fetchMock = mockFetch(400, {
      error: 'invalid_client',
      error_description: 'The OAuth client was not found.',
    });
    await expect(refreshAccessToken(config, fetchMock)).rejects.toThrow(
      'google_oauth_error: invalid_client',
    );
  });

  it('throws on network error', async () => {
    const throwingFetch = vi
      .fn()
      .mockRejectedValue(new Error('connection refused'));
    await expect(
      refreshAccessToken(config, throwingFetch as unknown as typeof fetch),
    ).rejects.toThrow('google_oauth_network_error: connection refused');
  });

  it('sends grant_type=refresh_token in body', async () => {
    const fetchSpy = mockFetch(200, OAUTH_SUCCESS);
    await refreshAccessToken(config, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.body as string).toContain('grant_type=refresh_token');
    expect(init.body as string).toContain('client_id=client-id-001');
    expect(init.body as string).toContain('refresh_token=refresh-token-001');
  });
});

// ---------------------------------------------------------------------------
// T-4-005 — client.ts (sendConversionUpload)
// ---------------------------------------------------------------------------

describe('sendConversionUpload', () => {
  const config = makeGoogleAdsConfig();

  const dummyPayload = mapEventToConversionUpload(
    makeEvent(),
    makeLaunchConfig(),
  );

  it('returns ok:true on 2xx without partialFailureError', async () => {
    const fetchMock = mockFetchChain(OAUTH_SUCCESS, 200, {
      results: [{ conversionAction: CONVERSION_ACTION }],
    });
    const result = await sendConversionUpload(dummyPayload, config, fetchMock);
    expect(result.ok).toBe(true);
  });

  it('returns rate_limit on 429', async () => {
    const fetchMock = mockFetchChain(OAUTH_SUCCESS, 429, {});
    const result = await sendConversionUpload(dummyPayload, config, fetchMock);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rate_limit');
  });

  it('returns server_error on 500', async () => {
    const fetchMock = mockFetchChain(OAUTH_SUCCESS, 500, {});
    const result = await sendConversionUpload(dummyPayload, config, fetchMock);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('server_error');
    if (result.kind !== 'server_error') return;
    expect(result.status).toBe(500);
  });

  it('returns permanent_failure with permission_denied on 403', async () => {
    const fetchMock = mockFetchChain(OAUTH_SUCCESS, 403, {});
    const result = await sendConversionUpload(dummyPayload, config, fetchMock);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
    if (result.kind !== 'permanent_failure') return;
    expect(result.code).toBe('permission_denied');
  });

  it('returns permanent_failure with invalid_gclid on partialFailureError INVALID_GCLID', async () => {
    const invalidGclidResponse = {
      results: [],
      partialFailureError: {
        code: 3,
        message: 'Multiple errors.',
        details: [
          {
            '@type':
              'type.googleapis.com/google.ads.googleads.v17.errors.GoogleAdsFailure',
            errors: [
              {
                errorCode: { conversionUploadError: 'INVALID_GCLID' },
                message: 'The gclid is not valid.',
              },
            ],
          },
        ],
      },
    };
    const fetchMock = mockFetchChain(OAUTH_SUCCESS, 200, invalidGclidResponse);
    const result = await sendConversionUpload(dummyPayload, config, fetchMock);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
    if (result.kind !== 'permanent_failure') return;
    expect(result.code).toBe('invalid_gclid');
  });

  it('returns permanent_failure with invalid_gclid on partialFailureError EXPIRED_GCLID', async () => {
    const expiredGclidResponse = {
      results: [],
      partialFailureError: {
        code: 3,
        details: [
          {
            errors: [
              {
                errorCode: { conversionUploadError: 'EXPIRED_GCLID' },
              },
            ],
          },
        ],
      },
    };
    const fetchMock = mockFetchChain(OAUTH_SUCCESS, 200, expiredGclidResponse);
    const result = await sendConversionUpload(dummyPayload, config, fetchMock);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
    if (result.kind !== 'permanent_failure') return;
    expect(result.code).toBe('invalid_gclid');
  });

  it('returns server_error on network error (fetch throws on API call)', async () => {
    // First call (OAuth) succeeds, second call (API) throws
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => OAUTH_SUCCESS,
      } as Response)
      .mockRejectedValueOnce(new Error('network unreachable'));
    const result = await sendConversionUpload(
      dummyPayload,
      config,
      fetchMock as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('server_error');
  });

  it('returns server_error when OAuth itself fails', async () => {
    const oauthErrorFetch = mockFetch(400, {
      error: 'invalid_grant',
      error_description: 'Token has been expired.',
    });
    const result = await sendConversionUpload(
      dummyPayload,
      config,
      oauthErrorFetch,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('server_error');
  });

  it('sends Authorization: Bearer header on API call', async () => {
    const fetchSpy = mockFetchChain(OAUTH_SUCCESS, 200, { results: [] });
    await sendConversionUpload(dummyPayload, config, fetchSpy);
    // Second call is the API call
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ya29.access-token-mock',
    );
  });

  it('sends developer-token header on API call', async () => {
    const fetchSpy = mockFetchChain(OAUTH_SUCCESS, 200, { results: [] });
    await sendConversionUpload(dummyPayload, config, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)['developer-token']).toBe(
      'dev-token-001',
    );
  });

  it('sends login-customer-id header when managerCustomerId provided', async () => {
    const configWithManager: GoogleAdsConfig = {
      ...config,
      managerCustomerId: '9999999999',
    };
    const fetchSpy = mockFetchChain(OAUTH_SUCCESS, 200, { results: [] });
    await sendConversionUpload(dummyPayload, configWithManager, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)['login-customer-id']).toBe(
      '9999999999',
    );
  });

  it('omits login-customer-id when managerCustomerId absent', async () => {
    const fetchSpy = mockFetchChain(OAUTH_SUCCESS, 200, { results: [] });
    await sendConversionUpload(dummyPayload, config, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(
      (init.headers as Record<string, string>)['login-customer-id'],
    ).toBeUndefined();
  });

  it('URL includes customer_id', async () => {
    const fetchSpy = mockFetchChain(OAUTH_SUCCESS, 200, { results: [] });
    await sendConversionUpload(dummyPayload, config, fetchSpy);
    const [url] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
    ];
    expect(url).toContain(CUSTOMER_ID);
    expect(url).toContain(':uploadClickConversions');
  });

  it('sends payload wrapped in { conversions: [payload], partialFailure: true }', async () => {
    const fetchSpy = mockFetchChain(OAUTH_SUCCESS, 200, { results: [] });
    await sendConversionUpload(dummyPayload, config, fetchSpy);
    const [, init] = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as {
      conversions: unknown[];
      partialFailure: boolean;
    };
    expect(Array.isArray(body.conversions)).toBe(true);
    expect(body.conversions).toHaveLength(1);
    expect(body.partialFailure).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-14-009-FOLLOWUP — accessToken direto (sem refresh interno)
// ---------------------------------------------------------------------------

describe('sendConversionUpload — accessToken direto (T-14-009-FOLLOWUP)', () => {
  const payload = mapEventToConversionUpload(makeEvent(), makeLaunchConfig());

  it('quando accessToken é fornecido, NÃO chama refreshAccessToken (sem fetch ao oauth2 endpoint)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ conversionAction: CONVERSION_ACTION }] }),
    });
    const result = await sendConversionUpload(
      payload,
      {
        accessToken: 'pre-resolved-token-XYZ',
        developerToken: 'dev-001',
        customerId: CUSTOMER_ID,
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(result.ok).toBe(true);
    // Apenas 1 fetch — direto pro Google Ads, sem oauth2 refresh.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer pre-resolved-token-XYZ');
  });

  it('quando NEM accessToken NEM oauth fornecidos, retorna permanent_failure no_credentials', async () => {
    const fetchMock = vi.fn();
    const result = await sendConversionUpload(
      payload,
      {
        developerToken: 'dev-001',
        customerId: CUSTOMER_ID,
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('permanent_failure');
    if (result.kind !== 'permanent_failure') return;
    expect(result.code).toBe('no_credentials');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('backward-compat: oauth-only ainda funciona (refresh interno)', async () => {
    const fetchMock = mockFetchChain(OAUTH_SUCCESS, 200, {
      results: [{ conversionAction: CONVERSION_ACTION }],
    });
    const result = await sendConversionUpload(
      payload,
      makeGoogleAdsConfig(),
      fetchMock,
    );
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-4-005 — classifyGoogleAdsError
// ---------------------------------------------------------------------------

describe('classifyGoogleAdsError', () => {
  it('BR-DISPATCH-003: rate_limit → retry', () => {
    const result: Extract<GoogleAdsResult, { ok: false }> = {
      ok: false,
      kind: 'rate_limit',
    };
    expect(classifyGoogleAdsError(result)).toBe('retry');
  });

  it('BR-DISPATCH-003: server_error → retry', () => {
    const result: Extract<GoogleAdsResult, { ok: false }> = {
      ok: false,
      kind: 'server_error',
      status: 500,
    };
    expect(classifyGoogleAdsError(result)).toBe('retry');
  });

  it('BR-DISPATCH-003: permanent_failure (invalid_gclid) → permanent', () => {
    const result: Extract<GoogleAdsResult, { ok: false }> = {
      ok: false,
      kind: 'permanent_failure',
      code: 'invalid_gclid',
    };
    expect(classifyGoogleAdsError(result)).toBe('permanent');
  });

  it('BR-DISPATCH-003: permanent_failure (permission_denied) → permanent', () => {
    const result: Extract<GoogleAdsResult, { ok: false }> = {
      ok: false,
      kind: 'permanent_failure',
      code: 'permission_denied',
    };
    expect(classifyGoogleAdsError(result)).toBe('permanent');
  });
});
