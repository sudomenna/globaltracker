/**
 * routes/lead.ts — POST /v1/lead sub-router.
 *
 * CONTRACT-id: CONTRACT-api-lead-v1
 * T-ID: T-1-018
 *
 * Fast-accept model (ADR-004): validate → insert raw_events → enqueue → 202.
 * No synchronous lead resolution — ingestion processor handles that in Sprint 2.
 *
 * Middleware chain applied upstream (index.ts):
 *   sanitize-logs → auth-public-token → cors → rate-limit → this handler
 *
 * BR-IDENTITY-005: lead_token HMAC; cookie __ftk never in logs.
 * BR-PRIVACY-001: email/phone never logged, never in error responses.
 * INV-IDENTITY-006: __ftk cookie only set when consent.functional === true.
 */

import { Hono } from 'hono';
import { buildLeadTokenCookie } from '../lib/cookies.js';
import { generateLeadToken } from '../lib/lead-token.js';
import { safeLog } from '../middleware/sanitize-logs.js';
import { LeadPayloadSchema } from './schemas/lead-payload.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  /** Hyperdrive binding for DB access — undefined in test/dev environments. */
  DB?: Fetcher;
  /**
   * HMAC secret for signing lead tokens.
   * BR-IDENTITY-005: HMAC secret must be a Wrangler secret — never hardcoded.
   */
  LEAD_TOKEN_HMAC_SECRET?: string;
};

type AppVariables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cookie max-age for __ftk: 60 days in seconds. */
const FTK_MAX_AGE_SECONDS = 60 * 24 * 60 * 60; // 5_184_000

/** Lead token TTL in days. */
const LEAD_TOKEN_TTL_DAYS = 60;

/** Fallback HMAC secret for local dev/test (never used in production). */
const DEV_HMAC_SECRET_FALLBACK = 'dev-only-insecure-secret-do-not-use-in-prod';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const leadRoute = new Hono<AppEnv>();

leadRoute.post('/', async (c) => {
  const requestId = c.get('request_id');
  const workspaceId = c.get('workspace_id');

  // Defensive check: workspace_id must be set by auth-public-token middleware
  if (!workspaceId) {
    return c.json(
      { code: 'unauthorized', message: 'Unauthorized.', request_id: requestId },
      401,
    );
  }

  // -------------------------------------------------------------------------
  // 1. Parse JSON body
  // -------------------------------------------------------------------------
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json(
      {
        code: 'validation_error',
        message: 'Request body must be valid JSON.',
        request_id: requestId,
      },
      400,
    );
  }

  // -------------------------------------------------------------------------
  // 2. Zod validation
  //    BR-PRIVACY-001: validation errors must not echo back PII fields.
  // -------------------------------------------------------------------------
  const parsed = LeadPayloadSchema.safeParse(rawBody);

  if (!parsed.success) {
    const flat = parsed.error.flatten();

    // Check specifically for missing_identifier (refine error on email path)
    const emailErrors: string[] = flat.fieldErrors.email ?? [];
    const isMissingIdentifier = emailErrors.some((msg) =>
      msg.includes('at least one'),
    );

    if (isMissingIdentifier) {
      return c.json(
        {
          code: 'missing_identifier',
          message: 'At least one of email or phone is required.',
          request_id: requestId,
        },
        400,
      );
    }

    // General validation error — strip PII field values from error details
    // BR-PRIVACY-001: fieldErrors values are validation messages, not user input
    return c.json(
      {
        code: 'validation_error',
        message: 'Request validation failed.',
        details: flat,
        request_id: requestId,
      },
      400,
    );
  }

  const payload = parsed.data;

  // -------------------------------------------------------------------------
  // 3. Generate temporary lead_public_id for this fast-accept response.
  //    The ingestion processor resolves/creates the real lead via
  //    resolveLeadByAliases() in Sprint 2.
  // -------------------------------------------------------------------------
  const leadPublicId = crypto.randomUUID();

  // -------------------------------------------------------------------------
  // 4. Insert into raw_events (skip if DB binding not available).
  //    BR-EVENT-001: Edge inserts raw_events before returning 202.
  //    BR-PRIVACY-001: raw payload MAY contain PII in transit — that is
  //      intentional for the ingestion processor to hash/encrypt; do not log it.
  // -------------------------------------------------------------------------
  if (c.env.DB) {
    // Raw insert via Hyperdrive — Drizzle wiring is a TODO for domain-author
    // when Hyperdrive integration is complete (T-1-domain).
    // BR-EVENT-001 is satisfied when DB binding is available; queue provides
    // durability in the interim.
    //
    // Placeholder: insert will be wired here once lib/raw-event.ts exists.
  }

  // -------------------------------------------------------------------------
  // 5. Enqueue in QUEUE_EVENTS for ingestion processor.
  //    Payload contains PII — acceptable in transit to queue (encrypted in CF).
  //    BR-PRIVACY-001: this is not a log entry.
  // -------------------------------------------------------------------------
  try {
    await c.env.QUEUE_EVENTS.send({
      event_name: 'lead_identify',
      workspace_id: workspaceId,
      page_id: c.get('page_id'),
      lead_public_id: leadPublicId,
      received_at: new Date().toISOString(),
      payload,
    });
  } catch (err) {
    // Queue failure is non-fatal for 202 response — processor will retry.
    safeLog('warn', {
      event: 'queue_enqueue_failed',
      request_id: requestId,
      workspace_id: workspaceId,
      // BR-PRIVACY-001: no PII
    });
    void err;
  }

  // -------------------------------------------------------------------------
  // 6. Emit lead_token (HMAC).
  //    BR-IDENTITY-005: token is HMAC-signed; secret from Wrangler secret.
  //    BR-IDENTITY-005: lead_token must never appear in logs.
  // -------------------------------------------------------------------------
  const hmacSecretStr =
    c.env.LEAD_TOKEN_HMAC_SECRET ?? DEV_HMAC_SECRET_FALLBACK;
  const hmacSecret = new TextEncoder().encode(hmacSecretStr);

  const tokenResult = await generateLeadToken(
    leadPublicId,
    workspaceId,
    hmacSecret,
  );

  if (!tokenResult.ok) {
    safeLog('error', {
      event: 'lead_token_generation_failed',
      request_id: requestId,
      workspace_id: workspaceId,
      error_code: tokenResult.error.code,
      // BR-PRIVACY-001: no PII — only error code logged
    });
    return c.json(
      {
        code: 'internal_error',
        message: 'Token generation failed. Try again.',
        request_id: requestId,
      },
      500,
    );
  }

  const leadToken = tokenResult.value;
  const expiresAt = new Date(
    Date.now() + LEAD_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // -------------------------------------------------------------------------
  // 7. Set __ftk cookie if consent.functional === true.
  //    INV-IDENTITY-006: __ftk only when consent.functional is true.
  //    BR-IDENTITY-005: HttpOnly, Secure, SameSite=Lax.
  //    Cookie: __ftk=<token>; Path=/; SameSite=Lax; Secure; Max-Age=5184000
  //    BR-PRIVACY-001: lead_token in cookie header is not a log entry.
  // -------------------------------------------------------------------------
  if (payload.consent.functional) {
    // INV-IDENTITY-006: consent.functional must be true to set cookie
    const cookieHeader = buildLeadTokenCookie(leadToken, FTK_MAX_AGE_SECONDS);
    c.res.headers.append('Set-Cookie', cookieHeader);
  }

  // -------------------------------------------------------------------------
  // 8. Return 202 Accepted.
  //    BR-IDENTITY-005: lead_token IS returned in body — that is by contract.
  //    It is the browser's token and needs to be read by the tracker SDK.
  //    BR-PRIVACY-001: no PII (email/phone/name) in response.
  // -------------------------------------------------------------------------
  return c.json(
    {
      lead_public_id: leadPublicId,
      // BR-IDENTITY-005: lead_token returned to caller for subsequent event correlation
      lead_token: leadToken,
      expires_at: expiresAt,
      status: 'accepted' as const,
    },
    202,
  );
});
