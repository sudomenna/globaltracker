/**
 * Google Ads Customer Match client — OfflineUserDataJob API.
 *
 * Used when audiences.destination_strategy='google_ads_api_allowlisted'.
 * Implements the three-step Google Ads job lifecycle:
 *   1. Create OfflineUserDataJob
 *   2. Add member operations (addOperations)
 *   3. Run the job (run)
 *
 * T-5-006
 *
 * ADR-012: this client is the legacy pathway for workspaces allowlisted before
 *   the Google 2026 Customer Match API cutoff. New workspaces use Data Manager.
 *
 * BR-AUDIENCE-001: this client is only instantiated when strategy resolves to
 *   'ads_api'. Never called for 'disabled_not_eligible' audiences.
 *
 * BR-AUDIENCE-002: callers must acquire a sync lock before invoking this
 *   client. Google Customer Match prohibits concurrent jobs on the same
 *   user list — lock prevents API-level conflicts.
 *
 * OAuth pattern follows apps/edge/src/dispatchers/google-ads-conversion/oauth.ts
 * (T-4-005) — stateless refresh on every invocation (no cache in CF Workers).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ADS_BASE = 'https://googleads.googleapis.com';
const GOOGLE_ADS_API_VERSION = 'v17';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single audience member identified by pre-hashed email and/or phone.
 *
 * BR-IDENTITY-002: leads.email_hash and phone_hash are already SHA-256
 *   normalized before storage — no re-hashing is performed here.
 * BR-PRIVACY-002: only hashes are transmitted; PII in clear is never sent.
 */
export interface GoogleMember {
  /** SHA-256 hex of the normalized (lowercase+trim) email. Null if absent. */
  hashedEmail: string | null;
  /** SHA-256 hex of the E.164-normalized phone number. Null if absent. */
  hashedPhoneNumber: string | null;
}

/** Credentials required by the Google Ads Customer Match client. */
export interface GoogleAdsCustomerMatchConfig {
  /** Google Ads Customer ID (without dashes, e.g. "1234567890"). */
  customerId: string;
  /** Google Ads Developer Token (sent as developer-token header). */
  developerToken: string;
  /** OAuth2 client_id for token refresh. */
  clientId: string;
  /** OAuth2 client_secret for token refresh. */
  clientSecret: string;
  /** Long-lived OAuth2 refresh_token used to obtain access tokens. */
  refreshToken: string;
}

/** Successful add/remove result referencing the created Google Ads job. */
export interface CustomerMatchJobResult {
  /** Resource name of the OfflineUserDataJob (returned by Google Ads API). */
  jobResourceName: string;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Typed error thrown by GoogleAdsCustomerMatchClient on known failure codes.
 *
 * The `isNotAllowlisted` flag drives the auto-demote path in processGoogleSyncJob:
 *   if true → audience.destination_strategy set to 'disabled_not_eligible'
 *             + auto_demoted_at = now() (ADR-012 / FLOW-05 §A2)
 *   if false and retryable=true → next_attempt_at scheduled with backoff
 *   if false and retryable=false → job fails permanently
 */
export class GoogleAdsCustomerMatchError extends Error {
  constructor(
    message: string,
    /** Short error code string for audiences_sync_jobs.error_code. */
    public readonly code: string,
    /**
     * True when Google returned CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE.
     * ADR-012: triggers auto-demote to disabled_not_eligible.
     */
    public readonly isNotAllowlisted: boolean,
    /**
     * True when the error is transient and the job should be retried with
     * backoff (BR-DISPATCH-003). False for permanent / allowlist failures.
     */
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GoogleAdsCustomerMatchError';
  }
}

// ---------------------------------------------------------------------------
// Internal raw API shapes
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

interface OfflineUserDataJobCreateResponse {
  resourceName: string;
}

interface GoogleAdsApiErrorDetail {
  '@type'?: string;
  errors?: Array<{
    errorCode?: {
      customerMatchError?: string;
      offlineUserDataJobError?: string;
    };
    message?: string;
  }>;
}

interface GoogleAdsApiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: GoogleAdsApiErrorDetail[];
  };
}

// ---------------------------------------------------------------------------
// Client class
// ---------------------------------------------------------------------------

/**
 * Sends Customer Match member add/remove operations to the Google Ads API
 * using the OfflineUserDataJob three-step flow.
 *
 * T-5-006
 * ADR-012: legacy allowlisted path only.
 */
export class GoogleAdsCustomerMatchClient {
  private readonly customerId: string;
  private readonly developerToken: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    config: GoogleAdsCustomerMatchConfig,
    fetchFn: typeof fetch = fetch,
  ) {
    this.customerId = config.customerId;
    this.developerToken = config.developerToken;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.refreshToken = config.refreshToken;
    this.fetchFn = fetchFn;
  }

  // -------------------------------------------------------------------------
  // OAuth helper (pattern from T-4-005 google-ads-conversion/oauth.ts)
  // -------------------------------------------------------------------------

  /**
   * Exchanges the refresh token for a short-lived access token.
   *
   * Stateless — no cache. CF Workers do not persist state between invocations.
   * Same pattern as apps/edge/src/dispatchers/google-ads-conversion/oauth.ts.
   */
  async refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
    });

    let response: Response;
    try {
      response = await this.fetchFn(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (networkError) {
      throw new GoogleAdsCustomerMatchError(
        `google_oauth_network_error: ${(networkError as Error).message}`,
        'OAUTH_NETWORK_ERROR',
        false,
        true, // network errors are retryable
      );
    }

    if (!response.ok) {
      let errBody: TokenErrorResponse = { error: 'unknown' };
      try {
        errBody = (await response.json()) as TokenErrorResponse;
      } catch {
        // ignore parse error
      }
      throw new GoogleAdsCustomerMatchError(
        `google_oauth_error: ${errBody.error}${errBody.error_description ? ` — ${errBody.error_description}` : ''}`,
        'OAUTH_ERROR',
        false,
        false, // credential errors are not retryable
      );
    }

    const data = (await response.json()) as TokenResponse;
    return data.access_token;
  }

  // -------------------------------------------------------------------------
  // Internal: common headers
  // -------------------------------------------------------------------------

  private buildHeaders(accessToken: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'developer-token': this.developerToken,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: create OfflineUserDataJob
  // -------------------------------------------------------------------------

  /**
   * Step 1: Creates an OfflineUserDataJob of type CUSTOMER_MATCH_USER_LIST.
   *
   * @returns the resource name of the created job (used in subsequent calls)
   */
  private async createJob(
    userListId: string,
    accessToken: string,
  ): Promise<string> {
    const url = `${GOOGLE_ADS_BASE}/${GOOGLE_ADS_API_VERSION}/customers/${encodeURIComponent(this.customerId)}/offlineUserDataJobs:create`;

    const body = JSON.stringify({
      job: {
        type: 'CUSTOMER_MATCH_USER_LIST',
        customerMatchUserListMetadata: {
          userList: `customers/${this.customerId}/userLists/${userListId}`,
        },
      },
    });

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: this.buildHeaders(accessToken),
        body,
      });
    } catch (networkError) {
      throw new GoogleAdsCustomerMatchError(
        `network_error creating OfflineUserDataJob: ${(networkError as Error).message}`,
        'NETWORK_ERROR',
        false,
        true,
      );
    }

    if (!response.ok) {
      await this.throwFromApiError(response);
    }

    const data = (await response.json()) as OfflineUserDataJobCreateResponse;
    return data.resourceName;
  }

  // -------------------------------------------------------------------------
  // Internal: add operations to job
  // -------------------------------------------------------------------------

  /**
   * Step 2: Adds member operations to an existing OfflineUserDataJob.
   *
   * @param jobResourceName - resource name from createJob()
   * @param members         - members to add or remove
   * @param remove          - if true, operations are removals; otherwise additions
   */
  private async addOperations(
    jobResourceName: string,
    members: GoogleMember[],
    remove: boolean,
    accessToken: string,
  ): Promise<void> {
    if (members.length === 0) return;

    const url = `${GOOGLE_ADS_BASE}/${GOOGLE_ADS_API_VERSION}/${jobResourceName}:addOperations`;

    // Build user_identifiers from hashes
    // BR-IDENTITY-002: hashes already normalized — pass through directly
    const operations = members.map((m) => {
      const userIdentifiers: Array<Record<string, string>> = [];
      if (m.hashedEmail) {
        userIdentifiers.push({ hashedEmail: m.hashedEmail });
      }
      if (m.hashedPhoneNumber) {
        userIdentifiers.push({ hashedPhoneNumber: m.hashedPhoneNumber });
      }
      return {
        create: {
          userIdentifiers,
        },
        remove,
      };
    });

    const body = JSON.stringify({ operations });

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: this.buildHeaders(accessToken),
        body,
      });
    } catch (networkError) {
      throw new GoogleAdsCustomerMatchError(
        `network_error adding operations: ${(networkError as Error).message}`,
        'NETWORK_ERROR',
        false,
        true,
      );
    }

    if (!response.ok) {
      await this.throwFromApiError(response);
    }
  }

  // -------------------------------------------------------------------------
  // Internal: run job
  // -------------------------------------------------------------------------

  /**
   * Step 3: Runs an OfflineUserDataJob (triggers async processing by Google).
   *
   * @param jobResourceName - resource name from createJob()
   */
  private async runJob(
    jobResourceName: string,
    accessToken: string,
  ): Promise<void> {
    const url = `${GOOGLE_ADS_BASE}/${GOOGLE_ADS_API_VERSION}/${jobResourceName}:run`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers: this.buildHeaders(accessToken),
        body: JSON.stringify({}),
      });
    } catch (networkError) {
      throw new GoogleAdsCustomerMatchError(
        `network_error running job: ${(networkError as Error).message}`,
        'NETWORK_ERROR',
        false,
        true,
      );
    }

    if (!response.ok) {
      await this.throwFromApiError(response);
    }
  }

  // -------------------------------------------------------------------------
  // Public: addMembers
  // -------------------------------------------------------------------------

  /**
   * Executes the full three-step OfflineUserDataJob flow for additions.
   *
   * T-5-006 / ADR-012 / FLOW-05
   *
   * @param userListId - Google Ads user list ID (from audiences.platform_resource_id)
   * @param members    - members to add
   * @returns { jobResourceName } reference for tracking
   * @throws GoogleAdsCustomerMatchError on API errors
   */
  async addMembers(
    userListId: string,
    members: GoogleMember[],
  ): Promise<CustomerMatchJobResult> {
    const accessToken = await this.refreshAccessToken();
    const jobResourceName = await this.createJob(userListId, accessToken);
    await this.addOperations(jobResourceName, members, false, accessToken);
    await this.runJob(jobResourceName, accessToken);
    return { jobResourceName };
  }

  // -------------------------------------------------------------------------
  // Public: removeMembers
  // -------------------------------------------------------------------------

  /**
   * Executes the full three-step OfflineUserDataJob flow for removals.
   *
   * T-5-006 / ADR-012 / FLOW-05
   *
   * @param userListId - Google Ads user list ID
   * @param members    - members to remove
   * @returns { jobResourceName } reference for tracking
   * @throws GoogleAdsCustomerMatchError on API errors
   */
  async removeMembers(
    userListId: string,
    members: GoogleMember[],
  ): Promise<CustomerMatchJobResult> {
    const accessToken = await this.refreshAccessToken();
    const jobResourceName = await this.createJob(userListId, accessToken);
    await this.addOperations(jobResourceName, members, true, accessToken);
    await this.runJob(jobResourceName, accessToken);
    return { jobResourceName };
  }

  // -------------------------------------------------------------------------
  // Internal: error classification and throw helper
  // -------------------------------------------------------------------------

  /**
   * Parses a non-ok Google Ads API response and throws a typed error.
   *
   * Special case: CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE triggers the
   * auto-demote path in processGoogleSyncJob (ADR-012 / FLOW-05 §A2).
   */
  private async throwFromApiError(response: Response): Promise<never> {
    let errBody: GoogleAdsApiErrorBody = {};
    try {
      errBody = (await response.json()) as GoogleAdsApiErrorBody;
    } catch {
      // ignore parse error — fall through to generic error
    }

    // Walk error details to find a specific error code
    const details = errBody.error?.details ?? [];
    const errorMessages: string[] = [];

    for (const detail of details) {
      for (const err of detail.errors ?? []) {
        const msg = err.message ?? '';
        errorMessages.push(msg);

        const customerMatchError = err.errorCode?.customerMatchError;
        const offlineJobError = err.errorCode?.offlineUserDataJobError;

        // ADR-012: CUSTOMER_NOT_ALLOWLISTED triggers auto-demote
        if (
          customerMatchError === 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE' ||
          offlineJobError === 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE' ||
          msg.includes('CUSTOMER_NOT_ALLOWLISTED')
        ) {
          throw new GoogleAdsCustomerMatchError(
            'Customer not allowlisted for Customer Match',
            'CUSTOMER_NOT_ALLOWLISTED',
            true, // isNotAllowlisted — triggers auto-demote
            false, // not retryable — a strategy change is required
          );
        }
      }
    }

    // HTTP 429 — rate limit, retryable (BR-DISPATCH-003)
    if (response.status === 429) {
      throw new GoogleAdsCustomerMatchError(
        'Google Ads rate limit exceeded',
        'RATE_LIMITED',
        false,
        true, // retryable
      );
    }

    // HTTP 5xx — server error, retryable (BR-DISPATCH-003)
    if (response.status >= 500) {
      throw new GoogleAdsCustomerMatchError(
        `Google Ads server error: HTTP ${response.status}`,
        'SERVER_ERROR',
        false,
        true, // retryable
      );
    }

    // HTTP 403 — permission denied, not retryable
    if (response.status === 403) {
      throw new GoogleAdsCustomerMatchError(
        `Google Ads permission denied: ${errBody.error?.message ?? 'unknown'}`,
        'PERMISSION_DENIED',
        false,
        false,
      );
    }

    // Generic 4xx — not retryable
    const summary =
      errorMessages.length > 0
        ? errorMessages.join('; ')
        : (errBody.error?.message ?? `HTTP ${response.status}`);

    throw new GoogleAdsCustomerMatchError(
      `Google Ads API error: ${summary}`,
      'API_ERROR',
      false,
      false,
    );
  }
}
