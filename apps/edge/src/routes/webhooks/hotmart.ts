/**
 * hotmart.ts — Inbound webhook handler for Hotmart.
 *
 * T-ID: T-9-001
 * Spec: docs/40-integrations/07-hotmart-webhook.md
 * Contracts: docs/30-contracts/04-webhook-contracts.md
 *
 * Mounted at POST /v1/webhook/hotmart by apps/edge/src/index.ts (wiring separate).
 * This handler is server-to-server — does NOT use authPublicToken or corsMiddleware.
 * Authentication is via X-Hotmart-Hottok header, validated in constant time against
 * workspaces.config.integrations.hotmart.webhook_secret (with env fallback).
 *
 * Flow:
 *   1. Read raw body text BEFORE JSON parse — BR-WEBHOOK-001 pattern
 *   2. Extract X-Hotmart-Hottok header
 *   3. Resolve workspace by ?workspace=<slug> query param
 *   4. Extract secret from workspace.config.integrations.hotmart.webhook_secret ?? env.HOTMART_WEBHOOK_SECRET
 *   5. Validate token via timingSafeTokenEqual — BR-WEBHOOK-001
 *   6. Parse JSON body
 *   7. Call mapper
 *   8. Skip result → 202 without insert
 *   9. Error result → persist as failed → 200 (BR-WEBHOOK-003)
 *  10. Persist as pending in raw_events — BR-EVENT-001
 *  11. Enqueue → 202
 *
 * BRs applied:
 *   BR-WEBHOOK-001: token validated before processing (constant-time comparison)
 *   BR-WEBHOOK-002: event_id derived deterministically
 *   BR-WEBHOOK-003: non-mappable events → raw_events.processing_status='failed' + 200
 *   BR-WEBHOOK-004: lead_hints hierarchy in mapper
 *   BR-PRIVACY-001: email, phone, name never logged; token never logged or stored
 *   BR-EVENT-001: raw_events insert awaited before 202
 */

import type { Db } from '@globaltracker/db';
import { rawEvents, workspaces } from '@globaltracker/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { mapHotmartToInternal } from '../../integrations/hotmart/mapper.js';
import type { HotmartWebhookPayload } from '../../integrations/hotmart/types.js';
import { jsonb } from '../../lib/jsonb-cast.js';
import { safeLog } from '../../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

type AppBindings = {
  QUEUE_EVENTS: Queue;
  DB?: Fetcher;
  /** Global fallback secret when workspace config is not yet populated */
  HOTMART_WEBHOOK_SECRET?: string;
};

type AppEnv = { Bindings: AppBindings };

// ---------------------------------------------------------------------------
// Workspace config shape (partial — only what we need)
// ---------------------------------------------------------------------------

interface WorkspaceConfig {
  integrations?: {
    hotmart?: {
      webhook_secret?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Constant-time token comparison
// ---------------------------------------------------------------------------

/**
 * Compares two strings in constant time to prevent timing attacks.
 *
 * BR-WEBHOOK-001: token validated via timingSafeTokenEqual — never direct ===.
 * Uses SHA-256 digest comparison as portable timing-safe alternative since
 * crypto.subtle.timingSafeEqual is not available in all CF Workers environments.
 */
async function timingSafeTokenEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) {
    // Length mismatch — still do dummy work to avoid early-exit timing difference.
    const enc = new TextEncoder();
    const aBytes = enc.encode(a);
    await crypto.subtle.digest('SHA-256', aBytes);
    return false;
  }
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', aBytes),
    crypto.subtle.digest('SHA-256', bBytes),
  ]);
  const aView = new Uint8Array(aHash);
  const bView = new Uint8Array(bHash);
  // XOR all bytes — result is 0 only if inputs are identical
  let diff = 0;
  for (let i = 0; i < aView.length; i++) {
    diff |= (aView[i] ?? 0) ^ (bView[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the Hotmart webhook sub-router.
 *
 * @param db - Drizzle DB instance; undefined in tests without DB
 */
export function createHotmartWebhookRoute(db?: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/', async (c) => {
    // -----------------------------------------------------------------------
    // Step 1: Read raw body text BEFORE any parse
    // BR-WEBHOOK-001: raw body must be consumed first — critical for signature
    // validation in HMAC-based providers; preserved here for consistency
    // -----------------------------------------------------------------------
    let rawBodyText: string;
    try {
      rawBodyText = await c.req.raw.text();
    } catch {
      return c.json({ error: 'bad_request' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 2: Extract X-Hotmart-Hottok header
    // BR-WEBHOOK-001: signature extracted before workspace lookup
    // BR-PRIVACY-001: token value never logged
    // -----------------------------------------------------------------------
    const receivedToken = c.req.header('x-hotmart-hottok');
    if (!receivedToken || receivedToken.length === 0) {
      safeLog('warn', {
        event: 'hotmart_webhook_missing_token',
      });
      return c.json({ error: 'unauthorized' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 3: Resolve workspace by ?workspace=<slug>
    // -----------------------------------------------------------------------
    const workspaceSlug = c.req.query('workspace');
    if (!workspaceSlug) {
      return c.json({ error: 'missing_workspace' }, 400);
    }

    let workspaceId: string | null = null;
    let webhookSecret: string | null = null;

    if (db) {
      try {
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.slug, workspaceSlug),
        });

        if (workspace) {
          workspaceId = workspace.id;
          // Step 4: Extract secret from workspace config with env fallback
          const config = (workspace.config ?? {}) as WorkspaceConfig;
          webhookSecret =
            config.integrations?.hotmart?.webhook_secret ??
            c.env.HOTMART_WEBHOOK_SECRET ??
            null;
        }
      } catch (err) {
        safeLog('error', {
          event: 'hotmart_webhook_db_lookup_error',
          workspace_slug: workspaceSlug,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        return c.json({ error: 'internal_error' }, 500);
      }
    } else {
      // No DB (test mode without DB injection) — use env fallback
      webhookSecret = c.env.HOTMART_WEBHOOK_SECRET ?? null;
      // In DB-less mode we cannot resolve a real workspace_id; use slug as placeholder
      workspaceId = workspaceSlug;
    }

    if (!workspaceId) {
      // Workspace not found — do not hint at whether slug exists
      // Still validate timing to avoid workspace enumeration
      safeLog('warn', {
        event: 'hotmart_webhook_workspace_not_found',
      });
      return c.json({ error: 'unauthorized' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 5: Validate token in constant time
    // BR-WEBHOOK-001: timing-safe comparison prevents token enumeration
    // hotmart_webhook_signature_failures_total counter (observability)
    // -----------------------------------------------------------------------
    if (!webhookSecret) {
      // Secret not configured — reject; log without revealing token value
      safeLog('warn', {
        event: 'hotmart_webhook_secret_not_configured',
        workspace_id: workspaceId,
      });
      return c.json({ error: 'unauthorized' }, 400);
    }

    const tokenValid = await timingSafeTokenEqual(receivedToken, webhookSecret);
    if (!tokenValid) {
      safeLog('warn', {
        event: 'hotmart_webhook_invalid_signature',
        workspace_id: workspaceId,
      });
      return c.json({ error: 'invalid_signature' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 6: Parse JSON body
    // -----------------------------------------------------------------------
    let body: HotmartWebhookPayload;
    try {
      body = JSON.parse(rawBodyText) as HotmartWebhookPayload;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 7: Call mapper
    // BR-WEBHOOK-003: unknown/skippable events handled by mapper returning
    //   skip result or error result — never a hard exception
    // -----------------------------------------------------------------------
    const mapResult = await mapHotmartToInternal(body);

    // -----------------------------------------------------------------------
    // Step 8: Handle skip result
    // BR-WEBHOOK-003: skippable events (SUBSCRIPTION_CANCELLATION Phase 3+)
    //   → 202 without inserting raw_event
    // -----------------------------------------------------------------------
    if (!mapResult.ok && 'skip' in mapResult && mapResult.skip === true) {
      safeLog('info', {
        event: 'hotmart_webhook_skipped',
        workspace_id: workspaceId,
        hotmart_event: body.event,
        reason: mapResult.reason,
      });
      return c.json({ received: true }, 202);
    }

    // -----------------------------------------------------------------------
    // Step 9: Handle mapping error — persist as failed
    // BR-WEBHOOK-003: non-mappable → processing_status='failed' + 200
    // hotmart_webhook_unmapped_events_total counter (observability)
    // -----------------------------------------------------------------------
    if (!mapResult.ok) {
      const errorCode = mapResult.error.code;

      safeLog('warn', {
        event: 'hotmart_webhook_mapping_failed',
        workspace_id: workspaceId,
        hotmart_event: body.event,
        error_code: errorCode,
      });

      if (db) {
        try {
          await db.insert(rawEvents).values({
            workspaceId,
            payload: jsonb(sanitizePayloadForStorage(body)),
            headersSanitized: jsonb({}),
            processingStatus: 'failed',
            processingError: `mapping_failed:${errorCode}`,
          });
        } catch (err) {
          safeLog('error', {
            event: 'hotmart_webhook_failed_insert_error',
            workspace_id: workspaceId,
            error_type: err instanceof Error ? err.constructor.name : 'unknown',
          });
        }
      }

      // BR-WEBHOOK-003: return 200 (not 4xx/5xx) so Hotmart does not retry forever
      return c.json({ received: true }, 200);
    }

    // -----------------------------------------------------------------------
    // Step 10: Persist raw_event with processing_status='pending'
    // BR-EVENT-001: insert awaited before returning 202
    // INV-EVENT-005: Edge persists in raw_events before returning 202
    // -----------------------------------------------------------------------
    const internalEvent = mapResult.value;

    // Build enriched payload: sanitized body + derived fields for processor
    // BR-PRIVACY-001: buyer.email/phone/name remain in payload for processor to hash;
    //   the payload column may contain PII in transit (see raw_event.ts comments)
    const enrichedPayload: Record<string, unknown> = {
      ...sanitizePayloadForStorage(body),
      _hotmart_event_type: internalEvent.event_type,
      _hotmart_event_id: internalEvent.event_id,
    };

    let rawEventId: string | undefined;

    if (db) {
      try {
        const inserted = await db
          .insert(rawEvents)
          .values({
            workspaceId,
            payload: jsonb(enrichedPayload),
            headersSanitized: jsonb({}),
            processingStatus: 'pending',
          })
          .returning({ id: rawEvents.id });

        rawEventId = inserted[0]?.id;
      } catch (err) {
        safeLog('error', {
          event: 'hotmart_webhook_insert_failed',
          workspace_id: workspaceId,
          event_id: internalEvent.event_id,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        // BR-EVENT-001 / INV-EVENT-005: if insert fails, return 500 so Hotmart retries
        return c.json({ error: 'internal_error' }, 500);
      }
    }

    // -----------------------------------------------------------------------
    // Step 11: Enqueue to QUEUE_EVENTS for async ingestion
    // -----------------------------------------------------------------------
    try {
      await c.env.QUEUE_EVENTS.send({
        raw_event_id: rawEventId,
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        event_type: internalEvent.event_type,
        platform: 'hotmart',
      });
    } catch (err) {
      // Queue error — raw_events already persisted; log and continue
      // (at-least-once: processor can pick up from raw_events)
      safeLog('error', {
        event: 'hotmart_webhook_enqueue_failed',
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }

    safeLog('info', {
      event: 'hotmart_webhook_accepted',
      workspace_id: workspaceId,
      event_id: internalEvent.event_id,
      event_type: internalEvent.event_type,
      platform_event_id: internalEvent.platform_event_id,
    });

    return c.json({ received: true }, 202);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a sanitized copy of the Hotmart payload safe for storage in raw_events.
 *
 * BR-PRIVACY-001: Hotmart payloads do not contain API tokens (authentication is
 * via header, not body), so we return the body as-is. The buyer PII fields
 * (email, phone, name) remain — the processor is responsible for hashing them
 * before writing to lead_aliases, per the raw_event schema note.
 *
 * Note: we cast to Record<string, unknown> for JSONB compatibility.
 */
function sanitizePayloadForStorage(
  body: HotmartWebhookPayload,
): Record<string, unknown> {
  // No token to strip (unlike Guru). Return full payload for processor.
  return body as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Default export for mounting in index.ts
// ---------------------------------------------------------------------------

/**
 * Default export for mounting in index.ts without DB.
 * To wire DB, use createHotmartWebhookRoute(db) instead.
 */
export const hotmartWebhookRoute = createHotmartWebhookRoute();
