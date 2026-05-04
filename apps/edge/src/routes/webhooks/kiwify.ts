/**
 * kiwify.ts — Inbound webhook handler for Kiwify.
 *
 * T-ID: T-9-002
 * Spec: docs/40-integrations/08-kiwify-webhook.md
 * Contracts: docs/30-contracts/04-webhook-contracts.md
 *
 * Mounted at POST /v1/webhook/kiwify by apps/edge/src/index.ts (after T-9-002).
 * This handler is server-to-server — does NOT use authPublicToken or
 * corsMiddleware. Authentication is via HMAC-SHA256 in X-Kiwify-Signature header.
 *
 * Flow:
 *   1. Read raw body text BEFORE any parse — BR-WEBHOOK-001 (critical for HMAC)
 *   2. Resolve workspace via ?workspace=<slug> query param
 *   3. Read webhook_secret from workspaces.config or KIWIFY_WEBHOOK_SECRET binding
 *   4. Verify X-Kiwify-Signature via HMAC-SHA256 in constant time — BR-WEBHOOK-001
 *   5. Parse JSON body
 *   6. Call mapper — mapKiwifyToInternal()
 *   7. Skip result → 200 (no insert — BR-WEBHOOK-003)
 *   8. Mapping error → persist as failed → 200 (BR-WEBHOOK-003)
 *   9. Persist as pending in raw_events — BR-EVENT-001
 *  10. Enqueue to QUEUE_EVENTS → 202
 *
 * BRs applied:
 *   BR-WEBHOOK-001: HMAC-SHA256 validated on raw body before processing; constant-time comparison
 *   BR-WEBHOOK-002: event_id derived deterministically from "kiwify:" + order.id + ":" + event_type
 *   BR-WEBHOOK-003: non-mappable events → raw_events.processing_status='failed' + 200 (no 4xx)
 *   BR-WEBHOOK-004: lead_hints hierarchy in mapper (metadata.lead_public_id → client_ref → email → phone)
 *   BR-PRIVACY-001: email, phone, name never logged; signature header never stored
 *   BR-EVENT-001: raw_events insert awaited before 202
 */

import type { Db } from '@globaltracker/db';
import { rawEvents, workspaces } from '@globaltracker/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { mapKiwifyToInternal } from '../../integrations/kiwify/mapper.js';
import type { KiwifyWebhookPayload } from '../../integrations/kiwify/types.js';
import { safeLog } from '../../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

type AppBindings = {
  QUEUE_EVENTS: Queue;
  DB?: Fetcher;
  KIWIFY_WEBHOOK_SECRET?: string;
};

type AppEnv = { Bindings: AppBindings };

// ---------------------------------------------------------------------------
// HMAC-SHA256 signature verification
// ---------------------------------------------------------------------------

/**
 * Computes HMAC-SHA256 of rawBody using secret and returns hex string.
 *
 * BR-WEBHOOK-001: raw body must be used — never parsed JSON re-serialization.
 */
async function computeHmacSha256(
  rawBody: string,
  secret: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  return Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compares two hex strings in constant time to prevent timing attacks.
 *
 * BR-WEBHOOK-001: timing-safe comparison — never direct string equality.
 * Hashes both inputs with SHA-256 before byte-by-byte XOR comparison,
 * ensuring constant time regardless of where bytes differ.
 */
async function timingSafeHexEqual(a: string, b: string): Promise<boolean> {
  // Length check is safe here — hex lengths reveal only algorithm, not secret content
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const av = new Uint8Array(aHash);
  const bv = new Uint8Array(bHash);
  let diff = 0;
  for (let i = 0; i < av.length; i++) {
    diff |= (av[i] ?? 0) ^ (bv[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Verifies Kiwify HMAC-SHA256 signature.
 *
 * BR-WEBHOOK-001: validate signature over raw body in constant time.
 *
 * @param rawBody - raw request body string (must be read before JSON.parse)
 * @param received - value of X-Kiwify-Signature header
 * @param secret - webhook secret for this workspace
 * @returns true if signature matches, false otherwise
 */
async function verifyKiwifySignature(
  rawBody: string,
  received: string,
  secret: string,
): Promise<boolean> {
  const computed = await computeHmacSha256(rawBody, secret);
  return timingSafeHexEqual(computed, received);
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the Kiwify webhook sub-router.
 *
 * @param db - Drizzle DB instance; undefined in tests without DB
 */
export function createKiwifyWebhookRoute(db?: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/', async (c) => {
    // -----------------------------------------------------------------------
    // Step 1: Read raw body text BEFORE any parse
    // BR-WEBHOOK-001: HMAC must be computed over the raw body string —
    // re-serializing parsed JSON would change byte-for-byte representation.
    // -----------------------------------------------------------------------
    let rawBodyText: string;
    try {
      rawBodyText = await c.req.raw.text();
    } catch {
      return c.json({ error: 'bad_request' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 2: Resolve workspace via ?workspace=<slug> query param
    // -----------------------------------------------------------------------
    const workspaceSlug = c.req.query('workspace');
    if (!workspaceSlug) {
      return c.json({ error: 'missing_workspace' }, 400);
    }

    let workspaceId: string | null = null;
    let workspaceConfig: Record<string, unknown> = {};

    if (db) {
      try {
        const ws = await db.query.workspaces.findFirst({
          where: eq(workspaces.slug, workspaceSlug),
          columns: { id: true, config: true, status: true },
        });

        if (!ws) {
          return c.json({ error: 'workspace_not_found' }, 400);
        }

        // INV-WORKSPACE-002: archived workspace rejects ingest
        if (ws.status === 'archived') {
          safeLog('warn', {
            event: 'kiwify_webhook_workspace_archived',
            workspace_slug: workspaceSlug,
          });
          return c.json({ error: 'workspace_unavailable' }, 400);
        }

        workspaceId = ws.id;
        workspaceConfig =
          (ws.config as Record<string, unknown> | null) ?? {};
      } catch (err) {
        safeLog('error', {
          event: 'kiwify_webhook_db_workspace_error',
          workspace_slug: workspaceSlug,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        return c.json({ error: 'internal_error' }, 500);
      }
    } else {
      // No DB — use slug as synthetic workspace_id for test environments
      workspaceId = workspaceSlug;
    }

    // -----------------------------------------------------------------------
    // Step 3: Read webhook_secret
    // Priority: workspaces.config.integrations.kiwify.webhook_secret → binding
    // BR-PRIVACY-001: secret is never logged
    // -----------------------------------------------------------------------
    const integrations = workspaceConfig['integrations'] as
      | Record<string, unknown>
      | undefined;
    const kiwifyConfig = integrations?.['kiwify'] as
      | Record<string, unknown>
      | undefined;
    const webhookSecret =
      (kiwifyConfig?.['webhook_secret'] as string | undefined) ??
      c.env.KIWIFY_WEBHOOK_SECRET;

    if (!webhookSecret) {
      safeLog('error', {
        event: 'kiwify_webhook_no_secret_configured',
        workspace_id: workspaceId,
      });
      return c.json({ error: 'internal_error' }, 500);
    }

    // -----------------------------------------------------------------------
    // Step 4: Verify X-Kiwify-Signature via HMAC-SHA256
    // BR-WEBHOOK-001: constant-time comparison; fail fast on invalid signature
    // -----------------------------------------------------------------------
    const receivedSignature = c.req.header('x-kiwify-signature');
    if (!receivedSignature) {
      safeLog('warn', {
        event: 'kiwify_webhook_missing_signature',
        workspace_id: workspaceId,
      });
      return c.json({ error: 'missing_signature' }, 400);
    }

    let signatureValid: boolean;
    try {
      signatureValid = await verifyKiwifySignature(
        rawBodyText,
        receivedSignature,
        webhookSecret,
      );
    } catch (err) {
      safeLog('error', {
        event: 'kiwify_webhook_signature_check_error',
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
      return c.json({ error: 'internal_error' }, 500);
    }

    if (!signatureValid) {
      // BR-WEBHOOK-001: invalid signature → 400 immediately; do not process payload
      // kiwify_webhook_signature_failures_total metric (observability)
      safeLog('warn', {
        event: 'kiwify_webhook_signature_invalid',
        workspace_id: workspaceId,
      });
      return c.json({ error: 'invalid_signature' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 5: Parse JSON body
    // -----------------------------------------------------------------------
    let body: KiwifyWebhookPayload;
    try {
      body = JSON.parse(rawBodyText) as KiwifyWebhookPayload;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    safeLog('info', {
      event: 'kiwify_webhook_received',
      workspace_id: workspaceId,
      // kiwify_webhook_received_total{event_type} metric label
      event_type: body.event_type,
    });

    // -----------------------------------------------------------------------
    // Step 6: Map payload to internal event
    // -----------------------------------------------------------------------
    const mapResult = await mapKiwifyToInternal(body);

    // -----------------------------------------------------------------------
    // Step 7: Handle skip result
    // BR-WEBHOOK-003: skippable event_types (subscription.canceled, unknown) →
    // return 200 without inserting raw_event (stop provider retrying)
    // -----------------------------------------------------------------------
    if (!mapResult.ok && 'skip' in mapResult && mapResult.skip === true) {
      safeLog('info', {
        event: 'kiwify_webhook_skipped',
        workspace_id: workspaceId,
        event_type: body.event_type,
        reason: mapResult.reason,
      });
      return c.json({ received: true }, 200);
    }

    // -----------------------------------------------------------------------
    // Step 8: Handle mapping error — persist as failed
    // BR-WEBHOOK-003: non-mappable → processing_status='failed' + 200
    // -----------------------------------------------------------------------
    if (!mapResult.ok) {
      const errorCode = mapResult.error.code;

      safeLog('warn', {
        event: 'kiwify_webhook_mapping_failed',
        workspace_id: workspaceId,
        event_type: body.event_type,
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
        } catch (insertErr) {
          safeLog('error', {
            event: 'kiwify_webhook_failed_insert_error',
            workspace_id: workspaceId,
            error_type:
              insertErr instanceof Error
                ? insertErr.constructor.name
                : 'unknown',
          });
        }
      }

      // BR-WEBHOOK-003: return 200 (not 4xx/5xx) so Kiwify does not retry forever
      return c.json({ received: true }, 200);
    }

    // -----------------------------------------------------------------------
    // Step 9: Persist raw_event with processing_status='pending'
    // BR-EVENT-001: insert awaited before returning 202
    // INV-EVENT-005: Edge persists in raw_events before returning 202
    // -----------------------------------------------------------------------
    const internalEvent = mapResult.value;
    let rawEventId: string | undefined;

    if (db) {
      const enrichedPayload: Record<string, unknown> = {
        ...sanitizePayloadForStorage(body),
        // Attach derived fields for processor convenience
        _kiwify_event_id: internalEvent.event_id,
        _kiwify_event_type: internalEvent.event_type,
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
          event: 'kiwify_webhook_insert_failed',
          workspace_id: workspaceId,
          event_id: internalEvent.event_id,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        // BR-EVENT-001: if insert fails, return 500 so Kiwify retries
        return c.json({ error: 'internal_error' }, 500);
      }
    }

    // -----------------------------------------------------------------------
    // Step 10: Enqueue to QUEUE_EVENTS for async ingestion
    // -----------------------------------------------------------------------
    try {
      await c.env.QUEUE_EVENTS.send({
        raw_event_id: rawEventId,
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        event_type: internalEvent.event_type,
        platform: 'kiwify',
      });
    } catch (err) {
      // Queue error — raw_events already persisted; log and continue
      // (at-least-once: processor can pick up from raw_events)
      safeLog('error', {
        event: 'kiwify_webhook_enqueue_failed',
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }

    safeLog('info', {
      event: 'kiwify_webhook_accepted',
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
 * Returns a sanitized copy of the Kiwify payload safe for storage in raw_events.
 *
 * BR-PRIVACY-001: PII is allowed in raw_events payload (processor hashes later),
 * but we remove deeply nested sensitive fields that serve no processing purpose
 * and keep the structure intact for the ingestion processor.
 *
 * Note: customer PII (email, phone, name) IS retained in the raw payload because
 * the ingestion processor needs it for lead resolution (hashing happens there).
 * This is per-spec: raw_events is the durability buffer; processor handles hashing.
 */
function sanitizePayloadForStorage(
  body: KiwifyWebhookPayload,
): Record<string, unknown> {
  // Cast to plain object for storage — no sensitive fields to strip for Kiwify
  // (unlike Guru which has api_token that must be stripped)
  return body as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Default export for mounting in index.ts
// ---------------------------------------------------------------------------

/**
 * Default export for mounting in index.ts.
 * To wire DB, use createKiwifyWebhookRoute(db) instead.
 */
export const kiwifyWebhookRoute = createKiwifyWebhookRoute();
