/**
 * middleware/turnstile.ts — Cloudflare Turnstile server-side verification.
 *
 * ADR-024: Turnstile as primary bot mitigation layer on /v1/lead.
 * BR-PRIVACY-001: token verification errors must not include PII in response.
 *
 * Validates cf_turnstile_response tokens via Cloudflare siteverify API.
 * Dev bypass: when ENVIRONMENT === 'development' and token is absent, skip verification.
 */

/** Cloudflare Turnstile siteverify endpoint. */
const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Response shape from Cloudflare siteverify API. */
interface TurnstileVerifyResponse {
  success: boolean;
  // eslint-disable-next-line @typescript-eslint/naming-convention -- external API field name
  error_codes?: string[];
  challenge_ts?: string;
  hostname?: string;
}

/**
 * Verify a Cloudflare Turnstile token against the siteverify API.
 *
 * ADR-024: validation < 5ms (no retry loop).
 * BR-PRIVACY-001: remoteIp is optional — pass only if available (not logged).
 *
 * @param token - The cf-turnstile-response token from the request body.
 * @param secretKey - TURNSTILE_SECRET_KEY Wrangler secret.
 * @param remoteIp - Optional client IP (hashed at call site if passed).
 * @returns { success: boolean, error_codes?: string[] }
 */
export async function verifyTurnstileToken(
  token: string,
  secretKey: string,
  remoteIp?: string,
): Promise<{ success: boolean; error_codes?: string[] }> {
  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) {
    body.set('remoteip', remoteIp);
  }

  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body,
    });
  } catch {
    // Network failure — treat as invalid to be safe
    // BR-PRIVACY-001: no PII in returned error
    return { success: false, error_codes: ['network-error'] };
  }

  if (!res.ok) {
    return { success: false, error_codes: ['siteverify-http-error'] };
  }

  let data: TurnstileVerifyResponse;
  try {
    data = (await res.json()) as TurnstileVerifyResponse;
  } catch {
    return { success: false, error_codes: ['siteverify-parse-error'] };
  }

  return { success: data.success, error_codes: data.error_codes };
}

/**
 * Check whether Turnstile verification should be skipped.
 *
 * ADR-024:
 *   - Token absent + ENVIRONMENT === 'development' → bypass.
 *   - Token absent + ENVIRONMENT !== 'development' → must reject (caller handles).
 *   - TURNSTILE_SECRET_KEY absent → bypass (binding not configured — dev/test).
 */
export function shouldBypassTurnstile(options: {
  token: string | undefined;
  secretKey: string | undefined;
  environment: string;
}): boolean {
  // No secret key binding → bypass (local dev / test without wrangler bindings)
  if (
    !options.secretKey ||
    options.secretKey === 'REPLACE_WITH_WRANGLER_SECRET'
  ) {
    return true;
  }
  // ADR-024: token absent in development → bypass
  if (!options.token && options.environment === 'development') {
    return true;
  }
  return false;
}
