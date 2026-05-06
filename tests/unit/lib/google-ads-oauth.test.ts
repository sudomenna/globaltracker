/**
 * Unit tests for apps/edge/src/lib/google-ads-oauth.ts — getGoogleAdsAccessToken()
 *
 * Tests:
 *   1. Cache miss → successful refresh → token returned + cached
 *   2. Cache hit within TTL (200s) → fetchFn not called again
 *   3. Cache expired (after 400s) → fetchFn called again
 *   4. invalid_grant → { ok: false, error: { code: 'oauth_token_revoked' } } + cache invalidated
 *   5. Config absent (no refresh_token) → { ok: false, error: { code: 'not_configured' } }
 *   6. Generic refresh failure → { ok: false, error: { code: 'oauth_refresh_failed' } }
 *
 * BR-PRIVACY-001: access_token and refresh_token never appear in logs (tested implicitly
 *   via mock — no PII assertion since the function doesn't log those).
 * BR-RBAC-002: workspace_id is cache key — no cross-workspace leak.
 *
 * T-14-015
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock @globaltracker/db — google-ads-oauth imports workspaces from it
vi.mock('@globaltracker/db', () => ({
  workspaces: { id: 'id', config: 'config', googleAdsDeveloperToken: 'google_ads_developer_token' },
  workspaceIntegrations: { workspaceId: 'workspace_id', googleAdsRefreshTokenEnc: 'google_ads_refresh_token_enc' },
  eq: vi.fn((a: unknown, b: unknown) => ({ _tag: 'eq', a, b })),
}));

// Mock google-ads-config — controls what resolveGoogleAdsCredentials returns
vi.mock('../../../apps/edge/src/lib/google-ads-config', () => ({
  resolveGoogleAdsCredentials: vi.fn(),
}));

// Mock the OAuth refresh in the conversion dispatcher
vi.mock('../../../apps/edge/src/dispatchers/google-ads-conversion/oauth', () => ({
  refreshAccessToken: vi.fn(),
}));

// Mock jsonb-cast (used by markOAuthTokenExpired)
vi.mock('../../../apps/edge/src/lib/jsonb-cast', () => ({
  jsonb: vi.fn((v: unknown) => v),
}));

// Mock safeLog to prevent console noise and allow inspection
vi.mock('../../../apps/edge/src/middleware/sanitize-logs', () => ({
  safeLog: vi.fn(),
}));

import {
  getGoogleAdsAccessToken,
  clearGoogleAdsAccessTokenCacheForTests,
  type GetGoogleAdsAccessTokenOpts,
} from '../../../apps/edge/src/lib/google-ads-oauth';
import { resolveGoogleAdsCredentials } from '../../../apps/edge/src/lib/google-ads-config';
import { refreshAccessToken } from '../../../apps/edge/src/dispatchers/google-ads-conversion/oauth';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const CUSTOMER_ID = '9876543210';
const DEVELOPER_TOKEN = 'dev-token-test';
const ACCESS_TOKEN = 'ya29.test_access_token';
const REFRESH_TOKEN_DECRYPTED = 'test_refresh_token_decrypted';

const ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000; // 300_000 ms — must match lib constant

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

/** Default resolved credentials returned by resolveGoogleAdsCredentials. */
function makeResolvedCredentials(overrides?: Record<string, unknown>) {
  return {
    ok: true as const,
    value: {
      customerId: CUSTOMER_ID,
      loginCustomerId: null,
      oauthTokenState: 'connected' as const,
      conversionActions: { Purchase: 'act/100' },
      enabled: true,
      hasRefreshToken: true,
      developerTokenSource: 'env' as const,
      refreshToken: REFRESH_TOKEN_DECRYPTED,
      developerToken: DEVELOPER_TOKEN,
      ...overrides,
    },
  };
}

/**
 * Minimal DB mock for google-ads-oauth.
 * Only markOAuthTokenExpired uses the DB (SELECT config + UPDATE).
 * The SELECT and UPDATE chains need to be present.
 */
function makeMockDb(workspaceConfig: Record<string, unknown> = {}) {
  const updateSetWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  const selectLimitFn = vi.fn().mockResolvedValue([{ config: workspaceConfig }]);
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: selectLimitFn }),
    }),
  });

  return {
    select,
    update,
    updateSet,
    updateSetWhere,
  } as unknown as Parameters<typeof getGoogleAdsAccessToken>[0]['db'];
}

/** Minimal MasterKeyRegistry mock — not used by getGoogleAdsAccessToken directly
 *  (it delegates to resolveGoogleAdsCredentials which is mocked). */
const MOCK_MASTER_KEY_REGISTRY = {} as Parameters<typeof getGoogleAdsAccessToken>[0]['masterKeyRegistry'];

/** Default opts for getGoogleAdsAccessToken. nowMs is injectable for time control. */
function makeOpts(overrides?: Partial<GetGoogleAdsAccessTokenOpts>): GetGoogleAdsAccessTokenOpts {
  return {
    db: makeMockDb(),
    workspaceId: WORKSPACE_ID,
    masterKeyRegistry: MOCK_MASTER_KEY_REGISTRY,
    envDeveloperToken: DEVELOPER_TOKEN,
    oauthClientId: 'client-id-test',
    oauthClientSecret: 'client-secret-test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getGoogleAdsAccessToken (T-14-015)', () => {
  beforeEach(() => {
    // Isolate cache between tests
    clearGoogleAdsAccessTokenCacheForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearGoogleAdsAccessTokenCacheForTests();
  });

  // -------------------------------------------------------------------------
  // Fixture 1: Cache miss → successful refresh → token returned
  // -------------------------------------------------------------------------

  it('cache miss → calls resolveGoogleAdsCredentials + refreshAccessToken, returns accessToken', async () => {
    vi.mocked(resolveGoogleAdsCredentials).mockResolvedValue(makeResolvedCredentials());
    vi.mocked(refreshAccessToken).mockResolvedValue(ACCESS_TOKEN);

    const opts = makeOpts();
    const result = await getGoogleAdsAccessToken(opts);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.accessToken).toBe(ACCESS_TOKEN);
    expect(result.value.customerId).toBe(CUSTOMER_ID);
    expect(result.value.developerToken).toBe(DEVELOPER_TOKEN);
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(resolveGoogleAdsCredentials).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Fixture 2: Cache hit within TTL — second call does NOT invoke fetchFn
  // -------------------------------------------------------------------------

  it('cache hit within TTL (200s elapsed) — fetchFn called only once across two invocations', async () => {
    vi.mocked(resolveGoogleAdsCredentials).mockResolvedValue(makeResolvedCredentials());
    vi.mocked(refreshAccessToken).mockResolvedValue(ACCESS_TOKEN);

    const baseTime = 1_000_000;
    const nowMs = vi.fn()
      .mockReturnValueOnce(baseTime)       // first call: populate cache
      .mockReturnValueOnce(baseTime + 200_000); // second call: 200s later, within TTL

    const opts = makeOpts({ nowMs });

    // First call — cache miss
    const result1 = await getGoogleAdsAccessToken(opts);
    expect(result1.ok).toBe(true);

    // Second call — cache hit (200s < 300s TTL)
    const result2 = await getGoogleAdsAccessToken(opts);
    expect(result2.ok).toBe(true);

    // fetchFn (refreshAccessToken) called only once
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(resolveGoogleAdsCredentials).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Fixture 3: Cache expired after TTL (400s) → fetchFn called again
  // -------------------------------------------------------------------------

  it('cache expired after TTL (400s elapsed) — fetchFn called twice', async () => {
    vi.mocked(resolveGoogleAdsCredentials).mockResolvedValue(makeResolvedCredentials());
    vi.mocked(refreshAccessToken)
      .mockResolvedValueOnce(ACCESS_TOKEN)
      .mockResolvedValueOnce('ya29.refreshed_token');

    const baseTime = 2_000_000;
    const nowMs = vi.fn()
      .mockReturnValueOnce(baseTime)                // first call: populate cache
      .mockReturnValueOnce(baseTime + ACCESS_TOKEN_TTL_MS + 100_000); // second call: expired

    const opts = makeOpts({ nowMs });

    // First call — cache miss
    await getGoogleAdsAccessToken(opts);

    // Second call — cache expired (400s > 300s TTL)
    const result2 = await getGoogleAdsAccessToken(opts);
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.value.accessToken).toBe('ya29.refreshed_token');

    // Both calls hit the refresh path
    expect(refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Fixture 4: invalid_grant → oauth_token_revoked + cache invalidated
  // -------------------------------------------------------------------------

  it('invalid_grant error → returns { ok: false, error: { code: "oauth_token_revoked" } } and next call re-fetches', async () => {
    vi.mocked(resolveGoogleAdsCredentials).mockResolvedValue(makeResolvedCredentials());
    // Simulate invalid_grant error from refreshAccessToken
    vi.mocked(refreshAccessToken)
      .mockRejectedValueOnce(new Error('google_oauth_error: invalid_grant — Token has been expired or revoked'))
      .mockResolvedValueOnce(ACCESS_TOKEN); // next call succeeds after re-connect

    const opts = makeOpts();

    const result = await getGoogleAdsAccessToken(opts);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('oauth_token_revoked');

    // Cache must be invalidated: next call must call refreshAccessToken again
    vi.mocked(resolveGoogleAdsCredentials).mockResolvedValue(makeResolvedCredentials());
    const result2 = await getGoogleAdsAccessToken(opts);
    expect(result2.ok).toBe(true);
    expect(refreshAccessToken).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Fixture 5: Config absent (no refresh_token) → not_configured
  // -------------------------------------------------------------------------

  it('resolveGoogleAdsCredentials returns not_configured → propagates { ok: false, error: { code: "not_configured" } }', async () => {
    vi.mocked(resolveGoogleAdsCredentials).mockResolvedValue({
      ok: false,
      error: {
        code: 'not_configured',
        message: 'Google Ads refresh_token not stored',
      },
    });

    const result = await getGoogleAdsAccessToken(makeOpts());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_configured');

    // refreshAccessToken should NOT be called
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Fixture 6: Generic refresh error (not invalid_grant) → oauth_refresh_failed
  // -------------------------------------------------------------------------

  it('generic refresh failure (network error) → returns { ok: false, error: { code: "oauth_refresh_failed" } }', async () => {
    vi.mocked(resolveGoogleAdsCredentials).mockResolvedValue(makeResolvedCredentials());
    vi.mocked(refreshAccessToken).mockRejectedValue(
      new Error('google_oauth_network_error: connection timeout'),
    );

    const result = await getGoogleAdsAccessToken(makeOpts());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('oauth_refresh_failed');

    // Must NOT throw — caller receives Result, not exception
  });

  // -------------------------------------------------------------------------
  // Extra: invalid_state (oauth_token_state !== 'connected') → invalid_state from config layer
  // -------------------------------------------------------------------------

  it('resolveGoogleAdsCredentials returns invalid_state → propagates error code', async () => {
    vi.mocked(resolveGoogleAdsCredentials).mockResolvedValue({
      ok: false,
      error: {
        code: 'invalid_state',
        message: 'Google Ads OAuth not connected (state=expired)',
        state: 'expired',
      },
    });

    const result = await getGoogleAdsAccessToken(makeOpts());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_state');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Extra: cache key isolation — different workspaces don't share cache
  // -------------------------------------------------------------------------

  it('BR-RBAC-002: cache is workspace-scoped — different workspace_ids get independent tokens', async () => {
    const TOKEN_A = 'ya29.token_workspace_a';
    const TOKEN_B = 'ya29.token_workspace_b';

    vi.mocked(resolveGoogleAdsCredentials)
      .mockResolvedValueOnce(makeResolvedCredentials())
      .mockResolvedValueOnce(makeResolvedCredentials({ customerId: '1111111111' }));

    vi.mocked(refreshAccessToken)
      .mockResolvedValueOnce(TOKEN_A)
      .mockResolvedValueOnce(TOKEN_B);

    const resultA = await getGoogleAdsAccessToken(makeOpts({ workspaceId: 'workspace-a' }));
    const resultB = await getGoogleAdsAccessToken(makeOpts({ workspaceId: 'workspace-b' }));

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    if (!resultA.ok || !resultB.ok) return;

    expect(resultA.value.accessToken).toBe(TOKEN_A);
    expect(resultB.value.accessToken).toBe(TOKEN_B);

    // Each workspace triggered a separate refresh
    expect(refreshAccessToken).toHaveBeenCalledTimes(2);
  });
});
