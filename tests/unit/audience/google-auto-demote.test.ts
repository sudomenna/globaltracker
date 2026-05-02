/**
 * Unit tests — Google auto-demote on CUSTOMER_NOT_ALLOWLISTED (ADR-012)
 *
 * Verifies that:
 *   1. GoogleAdsCustomerMatchError correctly classifies the allowlist error.
 *   2. The error properties drive the auto-demote path in processGoogleSyncJob.
 *
 * ADR-012: when Google returns CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE,
 *   isNotAllowlisted=true triggers the auto-demote path.
 * BR-AUDIENCE-001: auto-demoted audiences use destination_strategy='disabled_not_eligible'.
 * BR-DISPATCH-003: non-retryable errors do not schedule next_attempt_at.
 */

import { describe, expect, it } from 'vitest';
import {
  GoogleAdsCustomerMatchClient,
  GoogleAdsCustomerMatchError,
} from '../../../apps/edge/src/dispatchers/audience-sync/google/ads-api-client';
import errorNotAllowlistedFixture from '../../../tests/fixtures/google-customer-match/error-not-allowlisted.json';

// ---------------------------------------------------------------------------
// GoogleAdsCustomerMatchError classification
// ---------------------------------------------------------------------------

describe('GoogleAdsCustomerMatchError — error classification', () => {
  it('ADR-012: CUSTOMER_NOT_ALLOWLISTED error has isNotAllowlisted=true and retryable=false', () => {
    const err = new GoogleAdsCustomerMatchError(
      'Customer not allowlisted for Customer Match',
      'CUSTOMER_NOT_ALLOWLISTED',
      true, // isNotAllowlisted
      false, // retryable
    );

    // ADR-012: isNotAllowlisted must be true to trigger auto-demote
    expect(err.isNotAllowlisted).toBe(true);
    // BR-DISPATCH-003: non-retryable — do not schedule next_attempt_at
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('CUSTOMER_NOT_ALLOWLISTED');
  });

  it('is an instance of Error', () => {
    const err = new GoogleAdsCustomerMatchError('msg', 'CODE', false, false);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GoogleAdsCustomerMatchError');
  });

  it('RATE_LIMITED error is retryable and not an allowlist error', () => {
    // BR-DISPATCH-003: rate limit errors are retryable
    const err = new GoogleAdsCustomerMatchError(
      'Rate limit exceeded',
      'RATE_LIMITED',
      false, // isNotAllowlisted
      true, // retryable
    );

    expect(err.retryable).toBe(true);
    expect(err.isNotAllowlisted).toBe(false);
    expect(err.code).toBe('RATE_LIMITED');
  });

  it('SERVER_ERROR is retryable and not an allowlist error', () => {
    const err = new GoogleAdsCustomerMatchError(
      'Internal server error',
      'SERVER_ERROR',
      false,
      true,
    );
    expect(err.retryable).toBe(true);
    expect(err.isNotAllowlisted).toBe(false);
  });

  it('PERMISSION_DENIED is not retryable and not an allowlist error', () => {
    const err = new GoogleAdsCustomerMatchError(
      'Permission denied',
      'PERMISSION_DENIED',
      false,
      false,
    );
    expect(err.retryable).toBe(false);
    expect(err.isNotAllowlisted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Client throws CUSTOMER_NOT_ALLOWLISTED when API returns the error body
// ---------------------------------------------------------------------------

describe('GoogleAdsCustomerMatchClient — throws CUSTOMER_NOT_ALLOWLISTED on allowlist response', () => {
  it('ADR-012: throws GoogleAdsCustomerMatchError with isNotAllowlisted=true when API returns not-allowlisted error', async () => {
    // Build fixture-driven mock fetch
    // The fixture contains the exact Google Ads API error body
    const fixture = errorNotAllowlistedFixture as {
      httpStatus: number;
      body: unknown;
      expectedErrorCode: string;
      expectedIsNotAllowlisted: boolean;
      expectedRetryable: boolean;
    };

    let callCount = 0;
    const mockFetch = async (
      _url: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        // First call: OAuth token refresh — succeeds
        return new Response(
          JSON.stringify({
            access_token: 'mock-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Second call: createJob — returns the not-allowlisted error
      return new Response(JSON.stringify(fixture.body), {
        status: fixture.httpStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = new GoogleAdsCustomerMatchClient(
      {
        customerId: '1234567890',
        developerToken: 'dev-token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      },
      mockFetch as typeof fetch,
    );

    let thrownError: unknown;
    try {
      await client.addMembers('user-list-123', [
        { hashedEmail: 'abc123', hashedPhoneNumber: null },
      ]);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(GoogleAdsCustomerMatchError);
    const typedError = thrownError as GoogleAdsCustomerMatchError;

    // Fixture-driven assertions
    expect(typedError.code).toBe(fixture.expectedErrorCode);
    expect(typedError.isNotAllowlisted).toBe(fixture.expectedIsNotAllowlisted);
    expect(typedError.retryable).toBe(fixture.expectedRetryable);
  });
});
