/**
 * onprofit.ts — Inbound webhook handler for OnProfit.
 *
 * Spec: real payload + status mapping confirmed with usuário (2026-05-09).
 * Mounted at POST /v1/webhooks/onprofit by apps/edge/src/index.ts.
 *
 * Server-to-server only — does NOT use authPublicToken or corsMiddleware.
 *
 * Flow:
 *   1. Read raw body text BEFORE JSON parse — BR-WEBHOOK-001 pattern (so HMAC
 *      validation can run on the exact bytes once OnProfit publishes their
 *      signature spec).
 *   2. Resolve workspace by ?workspace=<slug> (same convention as Hotmart).
 *      TODO: switch to HMAC header validation when OnProfit publishes the spec.
 *   3. Parse JSON body.
 *   4. Call mapper.
 *   5. Skip → 202 (no insert).
 *   6. Mapping error → persist as failed → 200 (BR-WEBHOOK-003).
 *   7. Persist as pending in raw_events with derived fields injected.
 *   8. Enqueue → 202.
 *
 * BRs applied:
 *   BR-WEBHOOK-001: server-to-server isolation; HMAC TODO until spec confirmed
 *   BR-WEBHOOK-002: event_id derived deterministically (in mapper)
 *   BR-WEBHOOK-003: non-mappable / unknown statuses → raw_events failed + 200
 *   BR-WEBHOOK-004: lead_hints hierarchy populated by mapper
 *   BR-PRIVACY-001: customer email/phone/name never logged; payload stored as-is
 *                   (processor hashes before persisting in lead_aliases)
 *   BR-EVENT-001: raw_events insert awaited before 202
 *   INV-EVENT-005: Edge persists raw_event before returning 202
 */

import type { Db } from '@globaltracker/db';
import { rawEvents, workspaces } from '@globaltracker/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { mapOnProfitToInternal } from '../../integrations/onprofit/mapper.js';
import type { OnProfitWebhookPayload } from '../../integrations/onprofit/types.js';
import { jsonb } from '../../lib/jsonb-cast.js';
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
// Route factory
// ---------------------------------------------------------------------------

/**
 * Dual-mode argument: a Db instance OR a factory `(env) => Db` to support
 * Cloudflare Workers Hyperdrive bindings (env-scoped) and tests (direct DB).
 * Mirrors the pattern used by createGuruWebhookRoute.
 */
type DbOrFactory = Db | ((env: AppBindings) => Db);

export function createOnprofitWebhookRoute(
  dbOrFactory?: DbOrFactory,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/', async (c) => {
    const db =
      typeof dbOrFactory === 'function' ? dbOrFactory(c.env) : dbOrFactory;

    // -----------------------------------------------------------------------
    // Step 1: Read raw body text BEFORE any parse.
    // BR-WEBHOOK-001: raw bytes must be consumed first so they remain
    // available for HMAC validation when OnProfit publishes the signature
    // header spec. Today no header is checked — see TODO below.
    // -----------------------------------------------------------------------
    let rawBodyText: string;
    try {
      rawBodyText = await c.req.raw.text();
    } catch {
      return c.json({ error: 'bad_request' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 2: Resolve workspace by ?workspace=<slug>.
    //
    // TODO(onprofit-hmac): replace this query-string-only auth with HMAC
    // header validation as soon as OnProfit publishes their signature spec.
    // Until then, the integration is protected only by:
    //   (a) the workspace slug (knowledge of which is workspace-private), and
    //   (b) the OnProfit dashboard restricting which URLs an account can post to.
    // This is weaker than what we require for production receipts; once the
    // spec lands, mirror the Hotmart timingSafeTokenEqual pattern.
    // -----------------------------------------------------------------------
    safeLog('warn', {
      event: 'onprofit_webhook_hmac_validation_todo',
      message:
        'WARN: HMAC validation TODO until OnProfit signature spec is confirmed',
    });

    const workspaceSlug = c.req.query('workspace');
    if (!workspaceSlug) {
      return c.json({ error: 'missing_workspace' }, 400);
    }

    let workspaceId: string | null = null;

    if (db) {
      try {
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.slug, workspaceSlug),
        });
        if (workspace) {
          workspaceId = workspace.id;
        }
      } catch (err) {
        safeLog('error', {
          event: 'onprofit_webhook_db_lookup_error',
          workspace_slug: workspaceSlug,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        return c.json({ error: 'internal_error' }, 500);
      }
    } else {
      // Test mode without DB — accept slug as placeholder workspaceId.
      workspaceId = workspaceSlug;
    }

    if (!workspaceId) {
      // BR-PRIVACY-001: do not hint at whether the slug exists.
      safeLog('warn', {
        event: 'onprofit_webhook_workspace_not_found',
      });
      return c.json({ error: 'unauthorized' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 3: Parse JSON body.
    // -----------------------------------------------------------------------
    let body: OnProfitWebhookPayload;
    try {
      body = JSON.parse(rawBodyText) as OnProfitWebhookPayload;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 4: Map payload.
    // BR-WEBHOOK-003: skippable/unknown statuses are returned as skip/error
    // results — never thrown.
    // -----------------------------------------------------------------------
    const mapResult = await mapOnProfitToInternal(body);

    // -----------------------------------------------------------------------
    // Step 5: Skip result → 202 without insert.
    // BR-WEBHOOK-003.
    // -----------------------------------------------------------------------
    if (!mapResult.ok && 'skip' in mapResult && mapResult.skip === true) {
      safeLog('info', {
        event: 'onprofit_webhook_skipped',
        workspace_id: workspaceId,
        onprofit_status: body.status,
        reason: mapResult.reason,
      });
      return c.json({ received: true }, 202);
    }

    // -----------------------------------------------------------------------
    // Step 6: Mapping error → persist as failed → 200.
    // BR-WEBHOOK-003: returning 200 (not 4xx/5xx) prevents OnProfit from
    // retrying forever on payloads we will never accept.
    // -----------------------------------------------------------------------
    if (!mapResult.ok) {
      const errorCode = mapResult.error.code;

      safeLog('warn', {
        event: 'onprofit_webhook_mapping_failed',
        workspace_id: workspaceId,
        onprofit_status: body.status,
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
            event: 'onprofit_webhook_failed_insert_error',
            workspace_id: workspaceId,
            error_type: err instanceof Error ? err.constructor.name : 'unknown',
          });
        }
      }

      return c.json({ received: true }, 200);
    }

    // -----------------------------------------------------------------------
    // Step 7: Persist raw_event with processing_status='pending'.
    // BR-EVENT-001 / INV-EVENT-005.
    // -----------------------------------------------------------------------
    const internalEvent = mapResult.value;

    // Build enriched payload — sanitized body + derived fields the processor
    // uses to short-circuit re-mapping. BR-PRIVACY-001: customer.email/phone/
    // name remain in payload for processor; never written to log columns.
    const enrichedPayload: Record<string, unknown> = {
      ...sanitizePayloadForStorage(body),
      _onprofit_event_type: internalEvent.event_type,
      _onprofit_event_id: internalEvent.event_id,
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
          event: 'onprofit_webhook_insert_failed',
          workspace_id: workspaceId,
          event_id: internalEvent.event_id,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        // BR-EVENT-001: persistence failure → 500 so OnProfit retries.
        return c.json({ error: 'internal_error' }, 500);
      }
    }

    // -----------------------------------------------------------------------
    // Step 8: Enqueue to QUEUE_EVENTS for async ingestion.
    // -----------------------------------------------------------------------
    try {
      await c.env.QUEUE_EVENTS.send({
        raw_event_id: rawEventId,
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        event_type: internalEvent.event_type,
        platform: 'onprofit',
      });
    } catch (err) {
      // At-least-once: raw_events already persisted; the processor can pick
      // up the row via a sweep job later if the queue send failed.
      safeLog('error', {
        event: 'onprofit_webhook_enqueue_failed',
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }

    safeLog('info', {
      event: 'onprofit_webhook_accepted',
      workspace_id: workspaceId,
      event_id: internalEvent.event_id,
      event_type: internalEvent.event_type,
      platform_event_id: internalEvent.platform_event_id,
      onprofit_status: body.status,
      // Visibility metric: did we receive Meta cookies on this order?
      // Non-PII (these are opaque tokens, not user identifiers).
      has_fbc: Boolean(internalEvent.meta_cookies?.fbc),
      has_fbp: Boolean(internalEvent.meta_cookies?.fbp),
    });

    return c.json({ received: true }, 202);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a copy of the OnProfit payload safe for storage in raw_events.
 *
 * BR-PRIVACY-001: OnProfit does not embed an API token in the payload body
 * (auth is via the workspace slug query param + HMAC header once spec lands),
 * so there is no secret to strip. The customer PII fields (email, phone,
 * cell, document, name) remain — the processor is responsible for hashing /
 * encrypting them before persisting in lead_aliases / leads.email_enc, per
 * the raw_events schema PII-in-transit allowance.
 */
function sanitizePayloadForStorage(
  body: OnProfitWebhookPayload,
): Record<string, unknown> {
  return body as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Default export for direct mounting in tests / index.ts without DB
// ---------------------------------------------------------------------------

export const onprofitWebhookRoute = createOnprofitWebhookRoute();
