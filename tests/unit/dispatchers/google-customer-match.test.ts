/**
 * Unit tests for the Google Customer Match dispatcher.
 *
 * Covers:
 *   T-5-006 — strategy.ts (selectGoogleStrategy)
 *   T-5-006 — eligibility.ts (checkGoogleEligibility)
 *   T-5-006 — ads-api-client.ts (GoogleAdsCustomerMatchClient, GoogleAdsCustomerMatchError)
 *   T-5-006 — data-manager-client.ts (syncWithDataManager stub)
 *
 * BRs tested:
 *   BR-AUDIENCE-001: disabled_not_eligible → no API call, eligibility returns false
 *   INV-AUDIENCE-004: dispatcher blocks call when strategy=disabled_not_eligible
 *   ADR-012: strategy selection: data_manager / ads_api / disabled
 *   BR-DISPATCH-003: retryable vs permanent error classification
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GoogleAdsCustomerMatchClient,
  GoogleAdsCustomerMatchError,
} from '../../../apps/edge/src/dispatchers/audience-sync/google/ads-api-client.js';
import type { GoogleMember } from '../../../apps/edge/src/dispatchers/audience-sync/google/ads-api-client.js';
import { syncWithDataManager } from '../../../apps/edge/src/dispatchers/audience-sync/google/data-manager-client.js';
import { checkGoogleEligibility } from '../../../apps/edge/src/dispatchers/audience-sync/google/eligibility.js';
import { selectGoogleStrategy } from '../../../apps/edge/src/dispatchers/audience-sync/google/strategy.js';

// ---------------------------------------------------------------------------
// strategy.ts tests
// ---------------------------------------------------------------------------

describe('selectGoogleStrategy', () => {
  it('maps google_data_manager → data_manager', () => {
    // ADR-012: post-2026 default pathway
    expect(selectGoogleStrategy('google_data_manager')).toBe('data_manager');
  });

  it('maps google_ads_api_allowlisted → ads_api', () => {
    // ADR-012: legacy allowlisted pathway
    expect(selectGoogleStrategy('google_ads_api_allowlisted')).toBe('ads_api');
  });

  it('maps disabled_not_eligible → disabled', () => {
    // BR-AUDIENCE-001: disabled_not_eligible must produce disabled strategy
    expect(selectGoogleStrategy('disabled_not_eligible')).toBe('disabled');
  });

  it('maps meta_custom_audience → disabled (wrong platform)', () => {
    // Defensive: Meta strategy on a Google audience should not produce active sync
    expect(selectGoogleStrategy('meta_custom_audience')).toBe('disabled');
  });

  it('maps unknown string → disabled', () => {
    expect(selectGoogleStrategy('some_unknown_strategy')).toBe('disabled');
  });
});

// ---------------------------------------------------------------------------
// eligibility.ts tests
// ---------------------------------------------------------------------------

describe('checkGoogleEligibility', () => {
  it('returns eligible=false for disabled_not_eligible strategy', () => {
    // BR-AUDIENCE-001 / INV-AUDIENCE-004: must block API call
    const result = checkGoogleEligibility(
      'disabled_not_eligible',
      'some-list-id',
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('destination_strategy=disabled_not_eligible');
  });

  it('returns eligible=false when platformResourceId is null', () => {
    const result = checkGoogleEligibility('google_ads_api_allowlisted', null);
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('platform_resource_id not configured');
  });

  it('returns eligible=false when platformResourceId is empty string', () => {
    // Empty string behaves like null — falsy check
    const result = checkGoogleEligibility('google_data_manager', '');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('platform_resource_id not configured');
  });

  it('returns eligible=true for google_data_manager with resource id', () => {
    const result = checkGoogleEligibility('google_data_manager', '9876543210');
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns eligible=true for google_ads_api_allowlisted with resource id', () => {
    const result = checkGoogleEligibility(
      'google_ads_api_allowlisted',
      '9876543210',
    );
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// data-manager-client.ts tests
// ---------------------------------------------------------------------------

describe('syncWithDataManager (stub)', () => {
  it('returns succeeded with 0 counts and stub note', async () => {
    const members: GoogleMember[] = [
      { hashedEmail: 'abc123', hashedPhoneNumber: null },
    ];
    const result = await syncWithDataManager('list-123', members, []);
    // ADR-012: stub returns 0 counts — spec not yet public
    expect(result.status).toBe('succeeded');
    expect(result.sentAdditions).toBe(0);
    expect(result.sentRemovals).toBe(0);
    expect(result.note).toBe('data_manager_stub_not_implemented');
  });

  it('returns succeeded with empty inputs', async () => {
    const result = await syncWithDataManager('list-456', [], []);
    expect(result.status).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// ads-api-client.ts tests
// ---------------------------------------------------------------------------

const CUSTOMER_ID = '1234567890';
const USER_LIST_ID = '9876543210';
const DEVELOPER_TOKEN = 'test-dev-token';
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const REFRESH_TOKEN = 'test-refresh-token';
const ACCESS_TOKEN = 'test-access-token';
const JOB_RESOURCE_NAME = `customers/${CUSTOMER_ID}/offlineUserDataJobs/111222333`;

const SAMPLE_MEMBERS: GoogleMember[] = [
  {
    hashedEmail:
      'a8d4b2e1c3f5d6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1',
    hashedPhoneNumber:
      'b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2',
  },
  {
    hashedEmail:
      'c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3',
    hashedPhoneNumber: null,
  },
];

/** Build a mock fetch that returns pre-defined responses in sequence. */
function buildMockFetch(
  responses: Array<{ ok: boolean; status: number; body: unknown }>,
) {
  const queue = [...responses];
  return vi.fn(
    async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      const next = queue.shift();
      if (!next) throw new Error('Unexpected extra fetch call');
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
}

describe('GoogleAdsCustomerMatchClient', () => {
  describe('addMembers (happy path)', () => {
    it('creates job, adds operations, runs job, returns jobResourceName', async () => {
      const mockFetch = buildMockFetch([
        // OAuth token exchange
        {
          ok: true,
          status: 200,
          body: {
            access_token: ACCESS_TOKEN,
            expires_in: 3600,
            token_type: 'Bearer',
          },
        },
        // Create OfflineUserDataJob
        { ok: true, status: 200, body: { resourceName: JOB_RESOURCE_NAME } },
        // addOperations
        { ok: true, status: 200, body: {} },
        // run
        { ok: true, status: 200, body: {} },
      ]);

      const client = new GoogleAdsCustomerMatchClient(
        {
          customerId: CUSTOMER_ID,
          developerToken: DEVELOPER_TOKEN,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
        },
        mockFetch as unknown as typeof fetch,
      );

      const result = await client.addMembers(USER_LIST_ID, SAMPLE_MEMBERS);

      expect(result.jobResourceName).toBe(JOB_RESOURCE_NAME);
      // Verify 4 fetch calls: token + create + addOps + run
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });
  });

  describe('removeMembers (happy path)', () => {
    it('creates job, adds removal operations, runs job', async () => {
      const mockFetch = buildMockFetch([
        {
          ok: true,
          status: 200,
          body: {
            access_token: ACCESS_TOKEN,
            expires_in: 3600,
            token_type: 'Bearer',
          },
        },
        { ok: true, status: 200, body: { resourceName: JOB_RESOURCE_NAME } },
        { ok: true, status: 200, body: {} },
        { ok: true, status: 200, body: {} },
      ]);

      const client = new GoogleAdsCustomerMatchClient(
        {
          customerId: CUSTOMER_ID,
          developerToken: DEVELOPER_TOKEN,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
        },
        mockFetch as unknown as typeof fetch,
      );

      const result = await client.removeMembers(USER_LIST_ID, SAMPLE_MEMBERS);

      expect(result.jobResourceName).toBe(JOB_RESOURCE_NAME);
      // Verify remove=true was passed in addOperations call
      const addOpsCall = mockFetch.mock.calls[2];
      const body = JSON.parse(addOpsCall?.[1]?.body as string) as {
        operations: Array<{ remove: boolean }>;
      };
      expect(body.operations.every((op) => op.remove === true)).toBe(true);
    });
  });

  describe('CUSTOMER_NOT_ALLOWLISTED error (ADR-012 auto-demote trigger)', () => {
    it('throws GoogleAdsCustomerMatchError with isNotAllowlisted=true, retryable=false', async () => {
      const notAllowlistedBody = {
        error: {
          code: 400,
          message: 'Request contains an invalid argument.',
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type':
                'type.googleapis.com/google.ads.googleads.v17.errors.GoogleAdsFailure',
              errors: [
                {
                  errorCode: {
                    customerMatchError:
                      'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE',
                  },
                  message: 'Customer not allowlisted for Customer Match.',
                },
              ],
            },
          ],
        },
      };

      const mockFetch = buildMockFetch([
        {
          ok: true,
          status: 200,
          body: {
            access_token: ACCESS_TOKEN,
            expires_in: 3600,
            token_type: 'Bearer',
          },
        },
        { ok: false, status: 400, body: notAllowlistedBody },
      ]);

      const client = new GoogleAdsCustomerMatchClient(
        {
          customerId: CUSTOMER_ID,
          developerToken: DEVELOPER_TOKEN,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
        },
        mockFetch as unknown as typeof fetch,
      );

      // ADR-012: this error must trigger auto-demote in the caller
      let caught: GoogleAdsCustomerMatchError | null = null;
      try {
        await client.addMembers(USER_LIST_ID, SAMPLE_MEMBERS);
      } catch (err) {
        if (err instanceof GoogleAdsCustomerMatchError) {
          caught = err;
        }
      }

      expect(caught).not.toBeNull();
      expect(caught?.isNotAllowlisted).toBe(true);
      expect(caught?.retryable).toBe(false);
      expect(caught?.code).toBe('CUSTOMER_NOT_ALLOWLISTED');
    });
  });

  describe('rate limit error (BR-DISPATCH-003)', () => {
    it('throws retryable GoogleAdsCustomerMatchError on HTTP 429', async () => {
      const mockFetch = buildMockFetch([
        {
          ok: true,
          status: 200,
          body: {
            access_token: ACCESS_TOKEN,
            expires_in: 3600,
            token_type: 'Bearer',
          },
        },
        {
          ok: false,
          status: 429,
          body: { error: { message: 'Rate limit exceeded' } },
        },
      ]);

      const client = new GoogleAdsCustomerMatchClient(
        {
          customerId: CUSTOMER_ID,
          developerToken: DEVELOPER_TOKEN,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
        },
        mockFetch as unknown as typeof fetch,
      );

      let caught: GoogleAdsCustomerMatchError | null = null;
      try {
        await client.addMembers(USER_LIST_ID, SAMPLE_MEMBERS);
      } catch (err) {
        if (err instanceof GoogleAdsCustomerMatchError) caught = err;
      }

      expect(caught).not.toBeNull();
      // BR-DISPATCH-003: 429 must be retryable
      expect(caught?.retryable).toBe(true);
      expect(caught?.isNotAllowlisted).toBe(false);
    });
  });

  describe('server error (BR-DISPATCH-003)', () => {
    it('throws retryable GoogleAdsCustomerMatchError on HTTP 500', async () => {
      const mockFetch = buildMockFetch([
        {
          ok: true,
          status: 200,
          body: {
            access_token: ACCESS_TOKEN,
            expires_in: 3600,
            token_type: 'Bearer',
          },
        },
        { ok: false, status: 500, body: {} },
      ]);

      const client = new GoogleAdsCustomerMatchClient(
        {
          customerId: CUSTOMER_ID,
          developerToken: DEVELOPER_TOKEN,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
        },
        mockFetch as unknown as typeof fetch,
      );

      let caught: GoogleAdsCustomerMatchError | null = null;
      try {
        await client.addMembers(USER_LIST_ID, SAMPLE_MEMBERS);
      } catch (err) {
        if (err instanceof GoogleAdsCustomerMatchError) caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught?.retryable).toBe(true);
    });
  });

  describe('permission denied (BR-DISPATCH-003)', () => {
    it('throws non-retryable GoogleAdsCustomerMatchError on HTTP 403', async () => {
      const mockFetch = buildMockFetch([
        {
          ok: true,
          status: 200,
          body: {
            access_token: ACCESS_TOKEN,
            expires_in: 3600,
            token_type: 'Bearer',
          },
        },
        {
          ok: false,
          status: 403,
          body: { error: { message: 'Permission denied' } },
        },
      ]);

      const client = new GoogleAdsCustomerMatchClient(
        {
          customerId: CUSTOMER_ID,
          developerToken: DEVELOPER_TOKEN,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
        },
        mockFetch as unknown as typeof fetch,
      );

      let caught: GoogleAdsCustomerMatchError | null = null;
      try {
        await client.addMembers(USER_LIST_ID, SAMPLE_MEMBERS);
      } catch (err) {
        if (err instanceof GoogleAdsCustomerMatchError) caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught?.retryable).toBe(false);
      expect(caught?.code).toBe('PERMISSION_DENIED');
    });
  });

  describe('OAuth failure', () => {
    it('throws retryable error on network failure during token refresh', async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const client = new GoogleAdsCustomerMatchClient(
        {
          customerId: CUSTOMER_ID,
          developerToken: DEVELOPER_TOKEN,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
        },
        mockFetch as unknown as typeof fetch,
      );

      let caught: GoogleAdsCustomerMatchError | null = null;
      try {
        await client.addMembers(USER_LIST_ID, SAMPLE_MEMBERS);
      } catch (err) {
        if (err instanceof GoogleAdsCustomerMatchError) caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught?.retryable).toBe(true);
      expect(caught?.code).toBe('OAUTH_NETWORK_ERROR');
    });

    it('throws non-retryable error on invalid credentials', async () => {
      const mockFetch = buildMockFetch([
        {
          ok: false,
          status: 400,
          body: { error: 'invalid_grant', error_description: 'Token expired' },
        },
      ]);

      const client = new GoogleAdsCustomerMatchClient(
        {
          customerId: CUSTOMER_ID,
          developerToken: DEVELOPER_TOKEN,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
        },
        mockFetch as unknown as typeof fetch,
      );

      let caught: GoogleAdsCustomerMatchError | null = null;
      try {
        await client.addMembers(USER_LIST_ID, SAMPLE_MEMBERS);
      } catch (err) {
        if (err instanceof GoogleAdsCustomerMatchError) caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught?.retryable).toBe(false);
      expect(caught?.code).toBe('OAUTH_ERROR');
    });
  });

  describe('empty members (no-op path)', () => {
    it('does not call addOperations when members list is empty', async () => {
      const mockFetch = buildMockFetch([
        // OAuth token exchange
        {
          ok: true,
          status: 200,
          body: {
            access_token: ACCESS_TOKEN,
            expires_in: 3600,
            token_type: 'Bearer',
          },
        },
        // Create job
        { ok: true, status: 200, body: { resourceName: JOB_RESOURCE_NAME } },
        // run (no addOperations because members is empty)
        { ok: true, status: 200, body: {} },
      ]);

      const client = new GoogleAdsCustomerMatchClient(
        {
          customerId: CUSTOMER_ID,
          developerToken: DEVELOPER_TOKEN,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          refreshToken: REFRESH_TOKEN,
        },
        mockFetch as unknown as typeof fetch,
      );

      await client.addMembers(USER_LIST_ID, []);

      // 3 calls: token + create + run (no addOperations for empty list)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});

// ---------------------------------------------------------------------------
// GoogleAdsCustomerMatchError type guard tests
// ---------------------------------------------------------------------------

describe('GoogleAdsCustomerMatchError', () => {
  it('is instanceof Error', () => {
    const err = new GoogleAdsCustomerMatchError('msg', 'CODE', false, true);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GoogleAdsCustomerMatchError);
    expect(err.name).toBe('GoogleAdsCustomerMatchError');
  });

  it('exposes code, isNotAllowlisted, retryable', () => {
    const err = new GoogleAdsCustomerMatchError(
      'not allowed',
      'CUSTOMER_NOT_ALLOWLISTED',
      true,
      false,
    );
    expect(err.code).toBe('CUSTOMER_NOT_ALLOWLISTED');
    expect(err.isNotAllowlisted).toBe(true);
    expect(err.retryable).toBe(false);
  });
});
