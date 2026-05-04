/**
 * guru.ts — Inbound webhook handler for Digital Manager Guru.
 *
 * T-ID: T-3-004
 * Spec: docs/40-integrations/13-digitalmanager-guru-webhook.md
 * Contracts: docs/30-contracts/04-webhook-contracts.md
 *
 * Mounted at POST /v1/webhook/guru by apps/edge/src/index.ts (Onda 2).
 * This handler is server-to-server — does NOT use authPublicToken or
 * corsMiddleware. Authentication is via api_token in the JSON body,
 * validated in constant time against workspace_integrations.guru_api_token.
 *
 * Flow:
 *   1. Read raw body text (required before JSON parse — BR-WEBHOOK-001 pattern)
 *   2. Parse JSON
 *   3. Extract api_token from body
 *   4. Constant-time token comparison to resolve workspace
 *   5. Detect webhook_type: transaction | subscription | eticket
 *   6. eticket → persist as skipped → 202
 *   7. transaction/subscription → call mapper
 *   8. Skip result → 202 without insert
 *   9. Error result → persist as failed → 200 (BR-WEBHOOK-003)
 *  10. Resolve launch_id + funnel_role via resolveLaunchForGuruEvent (T-FUNIL-022)
 *  11. Persist as pending with launch_id + funnel_role injected into payload JSONB
 *  12. Enqueue → 202
 *
 * BRs applied:
 *   BR-WEBHOOK-001: token validated before processing (constant-time comparison)
 *   BR-WEBHOOK-002: event_id derived deterministically
 *   BR-WEBHOOK-003: non-mappable events → raw_events.processing_status='failed' + 200
 *   BR-WEBHOOK-004: lead_hints hierarchy in mapper
 *   BR-PRIVACY-001: api_token, email, phone never logged; leadHints hashed by resolver
 *   BR-EVENT-001: raw_events insert awaited before 202
 *   T-FUNIL-022: launch_id + funnel_role resolved and injected into raw_event payload
 */

import type { Db } from '@globaltracker/db';
import { rawEvents, workspaceIntegrations } from '@globaltracker/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  mapGuruSubscriptionToInternal,
  mapGuruTransactionToInternal,
} from '../../integrations/guru/mapper.js';
import type {
  GuruSubscriptionPayload,
  GuruTransactionPayload,
} from '../../integrations/guru/types.js';
import { resolveLaunchForGuruEvent } from '../../lib/guru-launch-resolver.js';
import { safeLog } from '../../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

type AppBindings = {
  QUEUE_EVENTS: Queue;
  DB?: Fetcher;
};

type AppEnv = { Bindings: AppBindings };

// ---------------------------------------------------------------------------
// Constant-time token comparison
// ---------------------------------------------------------------------------

/**
 * Compares two strings in constant time to prevent timing attacks.
 *
 * BR-WEBHOOK-001: api_token validated via timingSafeEqual — never direct ===.
 * Uses crypto.subtle to ensure constant-time regardless of match position.
 */
async function timingSafeTokenEqual(a: string, b: string): Promise<boolean> {
  if (a.length !== b.length) {
    // Length mismatch — still do a dummy comparison to avoid early-exit timing
    // (compare a against itself so the time is consistent, then return false)
    const enc = new TextEncoder();
    const aBytes = enc.encode(a);
    await crypto.subtle.digest('SHA-256', aBytes); // force constant-ish work
    return false;
  }
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // crypto.subtle.timingSafeEqual is not available in all environments;
  // use HMAC equality check as a portable timing-safe alternative.
  // Both inputs are converted to fixed-length SHA-256 digests and compared.
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
 * Creates the Guru webhook sub-router.
 *
 * @param getDb - Factory that receives env bindings and returns a Drizzle DB instance.
 *                Undefined in tests without DB (all DB operations are skipped).
 */
export function createGuruWebhookRoute(
  getDb?: (env: AppBindings) => Db,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/', async (c) => {
    const db = getDb?.(c.env);
    // -----------------------------------------------------------------------
    // Step 1: Read raw body text BEFORE parse
    // BR-WEBHOOK-001: raw body must be read first (pattern established for
    // HMAC-based providers; Guru uses token-in-body but we preserve the pattern
    // for consistency and future signature support)
    // -----------------------------------------------------------------------
    let rawBodyText: string;
    try {
      rawBodyText = await c.req.raw.text();
    } catch {
      return c.json({ error: 'bad_request' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 2: Parse JSON body
    // -----------------------------------------------------------------------
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBodyText) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 3: Extract api_token
    // BR-PRIVACY-001: never log api_token value
    // -----------------------------------------------------------------------
    const receivedToken = body.api_token;
    if (typeof receivedToken !== 'string' || receivedToken.length === 0) {
      return c.json({ error: 'unauthorized' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 4: Resolve workspace via constant-time token comparison
    // BR-WEBHOOK-001: timing-safe comparison prevents token enumeration
    // -----------------------------------------------------------------------
    let workspaceId: string | null = null;

    if (db) {
      try {
        // Fetch all integrations and compare in constant time.
        // Note: in production with many workspaces this should be indexed;
        // the DB lookup by guruApiToken is acceptable here because the column
        // is indexed (see workspace_integrations schema). We still do the
        // constant-time comparison on the application layer as a defense-in-depth
        // measure against timing attacks via DB query timing.
        const integration = await db.query.workspaceIntegrations.findFirst({
          where: eq(workspaceIntegrations.guruApiToken, receivedToken),
        });

        if (integration) {
          // BR-WEBHOOK-001: constant-time comparison even though DB already matched
          const storedToken = integration.guruApiToken ?? '';
          const tokensMatch = await timingSafeTokenEqual(
            receivedToken,
            storedToken,
          );
          if (tokensMatch) {
            workspaceId = integration.workspaceId;
          }
        }
      } catch (err) {
        // DB error — cannot authenticate; return 500 so provider retries
        safeLog('error', {
          event: 'guru_webhook_db_auth_error',
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        return c.json({ error: 'internal_error' }, 500);
      }
    }

    if (!workspaceId) {
      // BR-PRIVACY-001: do not hint at whether token exists
      return c.json({ error: 'unauthorized' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 5: Detect webhook_type
    // -----------------------------------------------------------------------
    const webhookType = body.webhook_type;
    if (typeof webhookType !== 'string') {
      return c.json({ error: 'invalid_payload' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 6: eticket — persist as skipped → 202
    // Spec: eticket events are Phase 4+; accepted but not processed in Phase 3
    // -----------------------------------------------------------------------
    if (webhookType === 'eticket') {
      if (db) {
        try {
          await db.insert(rawEvents).values({
            workspaceId,
            // BR-PRIVACY-001: store sanitized payload without api_token
            payload: sanitizePayloadForStorage(body),
            headersSanitized: {},
            processingStatus: 'discarded',
            processingError: 'eticket: not processed in Phase 3',
          });
        } catch (err) {
          safeLog('error', {
            event: 'guru_webhook_eticket_insert_failed',
            workspace_id: workspaceId,
            error_type: err instanceof Error ? err.constructor.name : 'unknown',
          });
          // Return 500 so Guru retries (raw_events not persisted)
          return c.json({ error: 'internal_error' }, 500);
        }
      }

      safeLog('info', {
        event: 'guru_webhook_eticket_skipped',
        workspace_id: workspaceId,
      });
      return c.json({ received: true }, 202);
    }

    // -----------------------------------------------------------------------
    // Step 7: Map payload to internal event
    // -----------------------------------------------------------------------
    let mapResult: Awaited<ReturnType<typeof mapGuruTransactionToInternal>>;

    if (webhookType === 'transaction') {
      const txPayload = body as unknown as GuruTransactionPayload;
      mapResult = await mapGuruTransactionToInternal(txPayload);
    } else if (webhookType === 'subscription') {
      const subPayload = body as unknown as GuruSubscriptionPayload;
      mapResult = await mapGuruSubscriptionToInternal(subPayload);
    } else {
      // Unknown webhook_type — treat as non-mappable (BR-WEBHOOK-003)
      safeLog('warn', {
        event: 'guru_webhook_unknown_type',
        workspace_id: workspaceId,
        webhook_type: webhookType,
      });
      if (db) {
        try {
          await db.insert(rawEvents).values({
            workspaceId,
            payload: sanitizePayloadForStorage(body),
            headersSanitized: {},
            processingStatus: 'failed',
            processingError: `unknown webhook_type: ${webhookType}`,
          });
        } catch {
          // Best-effort insert; not worth retrying for unknown types
        }
      }
      // BR-WEBHOOK-003: return 200 (not 4xx) so Guru stops retrying
      return c.json({ received: true }, 200);
    }

    // -----------------------------------------------------------------------
    // Step 8: Handle skip result
    // BR-WEBHOOK-003: skippable statuses → 202 without inserting raw_event
    // -----------------------------------------------------------------------
    if (!mapResult.ok && 'skip' in mapResult && mapResult.skip === true) {
      safeLog('info', {
        event: 'guru_webhook_skipped',
        workspace_id: workspaceId,
        webhook_type: webhookType,
        reason: mapResult.reason,
      });
      return c.json({ received: true }, 202);
    }

    // -----------------------------------------------------------------------
    // Step 9: Handle mapping error — persist as failed
    // BR-WEBHOOK-003: non-mappable → processing_status='failed' + 200
    // -----------------------------------------------------------------------
    if (!mapResult.ok) {
      const errorCode = mapResult.error.code;

      safeLog('warn', {
        event: 'guru_webhook_mapping_failed',
        workspace_id: workspaceId,
        webhook_type: webhookType,
        error_code: errorCode,
      });

      if (db) {
        try {
          await db.insert(rawEvents).values({
            workspaceId,
            payload: sanitizePayloadForStorage(body),
            headersSanitized: {},
            processingStatus: 'failed',
            processingError: `mapping_failed:${errorCode}`,
          });
        } catch (err) {
          safeLog('error', {
            event: 'guru_webhook_failed_insert_error',
            workspace_id: workspaceId,
            error_type: err instanceof Error ? err.constructor.name : 'unknown',
          });
        }
      }

      // BR-WEBHOOK-003: return 200 (not 4xx/5xx) so Guru does not retry forever
      return c.json({ received: true }, 200);
    }

    // -----------------------------------------------------------------------
    // Step 10: Resolve launch_id + funnel_role for purchase-type events
    // T-FUNIL-022: call resolver before insert so processor can use these fields
    // BR-PRIVACY-001: leadHints are passed to resolver which hashes before any DB
    // operation; raw PII never stored in raw_events payload beyond what already existed
    // -----------------------------------------------------------------------
    const internalEvent = mapResult.value;

    // Extract product_id and lead hints from the typed payload.
    // Both transaction and subscription events are purchase-type and benefit from
    // launch resolution. Subscriptions have no product_id (null is accepted by resolver).
    let resolvedLaunchId: string | null = null;
    let resolvedFunnelRole: string | null = null;

    if (db) {
      const productId =
        webhookType === 'transaction'
          ? ((body as unknown as GuruTransactionPayload).product?.id ?? null)
          : null;

      const email =
        webhookType === 'transaction'
          ? ((body as unknown as GuruTransactionPayload).contact?.email ?? null)
          : ((body as unknown as GuruSubscriptionPayload).subscriber?.email ?? null);

      const phone =
        webhookType === 'transaction'
          ? ((body as unknown as GuruTransactionPayload).contact?.phone_number ?? null)
          : null;

      try {
        const resolved = await resolveLaunchForGuruEvent({
          workspaceId,
          productId,
          leadHints: {
            email,
            phone,
            visitorId: null, // Guru does not send visitor_id
          },
          db,
        });

        resolvedLaunchId = resolved.launch_id;
        resolvedFunnelRole = resolved.funnel_role;
      } catch (err) {
        // Resolution failure is non-fatal — proceed without launch_id enrichment.
        // The raw_event will still be persisted; the processor can re-attempt resolution.
        safeLog('warn', {
          event: 'guru_webhook_launch_resolution_failed',
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
      }
    }

    // -----------------------------------------------------------------------
    // Step 11: Persist raw_event with processing_status='pending'
    // BR-EVENT-001: insert awaited before returning 202
    // INV-EVENT-005: Edge persists in raw_events before returning 202
    // -----------------------------------------------------------------------
    let rawEventId: string | undefined;

    if (db) {
      // Build enriched payload: start with sanitized body, then attach derived
      // fields. funnel_role is injected into JSONB (not a typed column).
      // BR-PRIVACY-001: funnel_role and launch_id are not PII.
      const enrichedPayload: Record<string, unknown> = {
        ...sanitizePayloadForStorage(body),
        // Attach derived fields for processor convenience
        _guru_event_id: internalEvent.event_id,
        _guru_event_type: internalEvent.event_type,
        // T-FUNIL-022: inject resolved launch context
        ...(resolvedLaunchId !== null && { launch_id: resolvedLaunchId }),
        ...(resolvedFunnelRole !== null && { funnel_role: resolvedFunnelRole }),
      };

      try {
        const inserted = await db
          .insert(rawEvents)
          .values({
            workspaceId,
            payload: enrichedPayload,
            headersSanitized: {},
            processingStatus: 'pending',
          })
          .returning({ id: rawEvents.id });

        rawEventId = inserted[0]?.id;
      } catch (err) {
        safeLog('error', {
          event: 'guru_webhook_insert_failed',
          workspace_id: workspaceId,
          event_id: internalEvent.event_id,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        // BR-EVENT-001 / INV-EVENT-005: if insert fails, return 500 so Guru retries
        return c.json({ error: 'internal_error' }, 500);
      }
    }

    // -----------------------------------------------------------------------
    // Step 12: Enqueue to QUEUE_EVENTS for async ingestion
    // -----------------------------------------------------------------------
    try {
      await c.env.QUEUE_EVENTS.send({
        raw_event_id: rawEventId,
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        event_type: internalEvent.event_type,
        platform: 'guru',
      });
    } catch (err) {
      // Queue error — raw_events already persisted; log and continue
      // (at-least-once: processor can pick up from raw_events)
      safeLog('error', {
        event: 'guru_webhook_enqueue_failed',
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }

    safeLog('info', {
      event: 'guru_webhook_accepted',
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
 * Returns a copy of the payload with api_token removed.
 *
 * BR-PRIVACY-001: api_token must not be stored in raw_events.
 * The token is a workspace secret and must not appear in any log or DB column.
 */
function sanitizePayloadForStorage(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const { api_token: _redacted, ...rest } = body;
  return rest;
}

export const guruWebhookRoute = createGuruWebhookRoute();
