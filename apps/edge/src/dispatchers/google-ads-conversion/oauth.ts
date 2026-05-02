/**
 * Google OAuth2 — refresh token exchange.
 *
 * Cloudflare Workers are stateless between invocations, so there is no token
 * cache. We exchange the refresh token for an access token on every dispatch.
 *
 * T-4-005
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Credentials needed to refresh a Google OAuth2 access token. */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Raw response from Google's token endpoint. */
interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

/** Error envelope returned by Google's token endpoint. */
interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Exchanges a Google OAuth2 refresh token for a short-lived access token.
 *
 * No caching — CF Workers have no persistent state between invocations.
 * Called on every dispatch invocation.
 *
 * T-4-005
 *
 * @param config   - OAuth credentials (client_id, client_secret, refresh_token)
 * @param fetchFn  - injectable fetch for testability (defaults to global fetch)
 * @throws Error when the token endpoint returns a non-2xx or an error field
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
      `google_oauth_network_error: ${(networkError as Error).message}`,
    );
  }

  if (!response.ok) {
    let errBody: TokenErrorResponse = { error: 'unknown' };
    try {
      errBody = (await response.json()) as TokenErrorResponse;
    } catch {
      // ignore parse error
    }
    throw new Error(
      `google_oauth_error: ${errBody.error}${errBody.error_description ? ` — ${errBody.error_description}` : ''}`,
    );
  }

  const data = (await response.json()) as TokenResponse;
  return data.access_token;
}
