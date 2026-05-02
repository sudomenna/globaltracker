/**
 * Google Ads OAuth helper — refresh_token → access_token.
 *
 * T-4-006
 * Intentionally self-contained within this dispatcher to avoid cross-ownership
 * coupling with google-ads-conversion (T-4-005). Both dispatchers own their
 * own OAuth helper per architectural decision (ownership disjoint).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration required to obtain a Google Ads access token. */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Google's token refresh response envelope. */
interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Exchanges a refresh token for a short-lived access token.
 *
 * T-4-006
 * fetch is injectable so the function is testable without real network I/O.
 *
 * @param config  - OAuth credentials (clientId, clientSecret, refreshToken)
 * @param fetchFn - injectable fetch (defaults to global fetch)
 * @returns access token string
 * @throws Error when the token endpoint returns a non-2xx response
 */
export async function refreshAccessToken(
  config: OAuthConfig,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
  });

  let response: Response;
  try {
    response = await fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (networkError) {
    throw new Error(
      `OAuth token refresh network error: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '(unreadable body)');
    throw new Error(
      `OAuth token refresh failed: HTTP ${response.status} — ${text}`,
    );
  }

  const data = (await response.json()) as GoogleTokenResponse;
  return data.access_token;
}
