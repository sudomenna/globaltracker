/**
 * routes/lead.ts — POST /v1/lead sub-router.
 *
 * CONTRACT-id: CONTRACT-api-lead-v1
 * T-ID: T-1-018, T-2-008
 *
 * Fast-accept model (ADR-004): validate → Turnstile → resolveLeadByAliases →
 *   issueLeadToken → Set-Cookie → 202.
 *
 * Middleware chain applied upstream (index.ts):
 *   sanitize-logs → auth-public-token → cors → rate-limit → this handler
 *
 * BR-IDENTITY-005: lead_token HMAC; cookie __ftk never in logs.
 * BR-PRIVACY-001: email/phone never logged, never in error responses.
 * INV-IDENTITY-006: __ftk cookie only set when consent.functional === true.
 * INV-IDENTITY-006: page_token_hash binds lead_token to the issuing page.
 */

import { createDb, rawEvents } from '@globaltracker/db';
import type { Db } from '@globaltracker/db';
import { Hono } from 'hono';
import { buildLeadTokenCookie } from '../lib/cookies.js';
import { resolveLeadByAliases } from '../lib/lead-resolver.js';
import { issueLeadToken } from '../lib/lead-token.js';
import { safeLog } from '../middleware/sanitize-logs.js';
import {
  shouldBypassTurnstile,
  verifyTurnstileToken,
} from '../middleware/turnstile.js';
import { LeadPayloadSchema } from './schemas/lead-payload.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DB?: Fetcher;
  HYPERDRIVE: Hyperdrive;
  DATABASE_URL?: string;
  LEAD_TOKEN_HMAC_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
};

/**
 * Optional DB injection for issueLeadToken.
 * Injected by app bootstrapper (index.ts); absent in unit tests without DB.
 */
export type LeadRouteDb = Db;

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
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create the lead sub-router with an optional Drizzle DB instance.
 *
 * When db is provided, the handler calls resolveLeadByAliases + issueLeadToken
 * synchronously and returns a real lead_token bound to a DB row.
 *
 * When db is absent (no Hyperdrive binding — e.g. unit tests), the handler falls
 * back to generating a temporary token without DB persistence and logs a warning.
 * This preserves the fast-accept 202 contract while allowing test environments
 * to operate without a live DB.
 *
 * T-2-008: real token path requires db.
 */
export function createLeadRoute(db?: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/', async (c) => {
    const requestId = c.get('request_id');
    const workspaceId = c.get('workspace_id');
    // Use injected db (tests) or create inline from env (production/dev).
    // Falls back to undefined when neither DATABASE_URL nor HYPERDRIVE is present
    // (unit test environments), preserving the no-db fallback path below.
    const effectiveDb: Db | undefined =
      db ??
      (c.env.DATABASE_URL || c.env.HYPERDRIVE
        ? createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString)
        : undefined);

    // Defensive check: workspace_id must be set by auth-public-token middleware
    if (!workspaceId) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Unauthorized.',
          request_id: requestId,
        },
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
    // 3. Turnstile bot verification (ADR-024).
    //    Runs after Zod validation but before any side effects (DB, queue).
    //    BR-PRIVACY-001: 403 response must not include PII (email/phone).
    // -------------------------------------------------------------------------
    const turnstileToken = payload.cf_turnstile_response;
    const turnstileSecret = c.env.TURNSTILE_SECRET_KEY;
    const environment = c.env.ENVIRONMENT ?? 'production';

    if (
      shouldBypassTurnstile({
        token: turnstileToken,
        secretKey: turnstileSecret,
        environment,
      })
    ) {
      // ADR-024: dev bypass or no secret binding configured — skip verification
      safeLog('info', {
        event: 'turnstile_bypass',
        request_id: requestId,
        workspace_id: workspaceId,
        reason: !turnstileSecret ? 'no_secret_binding' : 'dev_environment',
      });
    } else if (!turnstileToken) {
      // ADR-024: token absent in non-development environment → 403
      // BR-PRIVACY-001: no PII in error response
      return c.json(
        {
          code: 'bot_detected',
          message: 'Bot verification failed.',
          request_id: requestId,
        },
        403,
      );
    } else {
      // Verify token against Cloudflare siteverify API
      // ADR-024: < 5ms latency target; no retry loop
      const result = await verifyTurnstileToken(
        turnstileToken,
        // turnstileSecret is guaranteed non-undefined here (shouldBypassTurnstile
        // returns true when it's absent, so we only reach this branch with a value)
        turnstileSecret as string,
      );

      if (!result.success) {
        // ADR-024: invalid token → 403 bot_detected
        // BR-PRIVACY-001: no PII (email/phone) in error response
        safeLog('warn', {
          event: 'turnstile_verification_failed',
          request_id: requestId,
          workspace_id: workspaceId,
          error_codes: result.error_codes,
          // BR-PRIVACY-001: no PII logged
        });
        return c.json(
          {
            code: 'bot_detected',
            message: 'Bot verification failed.',
            request_id: requestId,
          },
          403,
        );
      }
    }

    // Strip cf_turnstile_response before inserting into raw_events.
    // ADR-024: it is a mitigation field, not a business field.
    const { cf_turnstile_response: _stripped, ...businessPayload } = payload;

    // -------------------------------------------------------------------------
    // 4. Resolve/create lead + issue real token (T-2-008).
    //
    //    When db is available: call resolveLeadByAliases → issueLeadToken.
    //    When db is absent:    fall back to temporary UUID + HMAC-only token
    //                          (no DB row — ingestion processor will create lead).
    //
    //    BR-IDENTITY-005: HMAC secret from Wrangler secret.
    //    INV-IDENTITY-006: page_token_hash bound to X-Funil-Site header value.
    // -------------------------------------------------------------------------
    const hmacSecretStr =
      c.env.LEAD_TOKEN_HMAC_SECRET ?? DEV_HMAC_SECRET_FALLBACK;
    const hmacSecret = new TextEncoder().encode(hmacSecretStr);

    let leadPublicId: string;
    let leadToken: string;
    let expiresAt: string;

    if (effectiveDb) {
      // -----------------------------------------------------------------------
      // T-2-008: DB path — real lead resolution + stateful token
      // -----------------------------------------------------------------------

      // 4a. Resolve or create lead via aliases
      const resolveResult = await resolveLeadByAliases(
        {
          email: businessPayload.email,
          phone: businessPayload.phone,
        },
        workspaceId,
        effectiveDb,
      );

      if (!resolveResult.ok) {
        safeLog('error', {
          event: 'lead_resolve_failed',
          request_id: requestId,
          workspace_id: workspaceId,
          error_code: resolveResult.error.code,
          // BR-PRIVACY-001: no PII logged
        });
        return c.json(
          {
            code: 'internal_error',
            message: 'Lead resolution failed. Try again.',
            request_id: requestId,
          },
          500,
        );
      }

      const leadId = resolveResult.value.lead_id;
      leadPublicId = leadId; // internal ID used as public ID for now (no separate public_id on leads table)

      // 4b. Compute page_token_hash from X-Funil-Site header
      // INV-IDENTITY-006: token bound to the issuing page_token
      const funiSiteHeader = c.req.header('x-funil-site') ?? '';
      const pageTokenHash = await sha256Hex(funiSiteHeader);

      // 4c. Issue stateful lead token
      const issueResult = await issueLeadToken(
        leadId,
        workspaceId,
        pageTokenHash,
        LEAD_TOKEN_TTL_DAYS,
        effectiveDb,
        hmacSecret,
      );

      if (!issueResult.ok) {
        safeLog('error', {
          event: 'lead_token_issue_failed',
          request_id: requestId,
          workspace_id: workspaceId,
          error_code: issueResult.error.code,
          // BR-PRIVACY-001: no PII logged
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

      leadToken = issueResult.value.token_clear;
      expiresAt = issueResult.value.expires_at.toISOString();
    } else {
      // -----------------------------------------------------------------------
      // Fallback path — no DB available (test/dev without Hyperdrive)
      // Generate temporary HMAC-only token; no DB row created.
      // Warning logged so ops can detect if this happens in production.
      // -----------------------------------------------------------------------
      safeLog('warn', {
        event: 'lead_token_no_db_fallback',
        request_id: requestId,
        workspace_id: workspaceId,
      });

      leadPublicId = crypto.randomUUID();

      // Import generateLeadToken lazily to keep the no-db path working
      const { generateLeadToken } = await import('../lib/lead-token.js');
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
          // BR-PRIVACY-001: no PII logged
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

      leadToken = tokenResult.value;
      expiresAt = new Date(
        Date.now() + LEAD_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
    }

    // -------------------------------------------------------------------------
    // 5. Insert into raw_events (skip if DB binding not available).
    //    BR-EVENT-001: Edge inserts raw_events before returning 202.
    //    BR-PRIVACY-001: raw payload MAY contain PII in transit — that is
    //      intentional for the ingestion processor to hash/encrypt; do not log it.
    // -------------------------------------------------------------------------
    let rawEventIdForQueue: string | undefined;
    try {
      const connString = c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString;
      const db = createDb(connString);
      const [inserted] = await db.insert(rawEvents).values({
        workspaceId,
        pageId: c.get('page_id'),
        payload: businessPayload as Record<string, unknown>,
        headersSanitized: {
          origin: c.req.header('origin') ?? null,
          cf_ray: c.req.header('cf-ray') ?? null,
        },
      }).returning({ id: rawEvents.id });
      rawEventIdForQueue = inserted?.id;
    } catch (err) {
      safeLog('error', {
        event: 'raw_events_insert_failed',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }

    // -------------------------------------------------------------------------
    // 6. Enqueue in QUEUE_EVENTS for ingestion processor.
    //    Payload contains PII — acceptable in transit to queue (encrypted in CF).
    //    BR-PRIVACY-001: this is not a log entry.
    // -------------------------------------------------------------------------
    try {
      await c.env.QUEUE_EVENTS.send({
        raw_event_id: rawEventIdForQueue,
        event_name: 'lead_identify',
        workspace_id: workspaceId,
        page_id: c.get('page_id'),
        lead_public_id: leadPublicId,
        received_at: new Date().toISOString(),
        // ADR-024: use businessPayload (cf_turnstile_response already stripped)
        payload: businessPayload,
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
    // 7. Set __ftk cookie if consent.functional === true.
    //    INV-IDENTITY-006: __ftk only when consent.functional is true.
    //    BR-IDENTITY-005: HttpOnly, Secure, SameSite=Lax.
    //    Cookie: __ftk=<token>; Path=/; SameSite=Lax; Secure; Max-Age=5184000
    //    BR-PRIVACY-001: lead_token in cookie header is not a log entry.
    // -------------------------------------------------------------------------
    if (businessPayload.consent.functional) {
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

  return router;
}

/** Default export — no DB wired (for backward compat / test imports). */
export const leadRoute = createLeadRoute();

// ---------------------------------------------------------------------------
// Internal helpers (used by the route only)
// ---------------------------------------------------------------------------

/** SHA-256 hex — Web Crypto only; CF Workers compatible. */
async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
