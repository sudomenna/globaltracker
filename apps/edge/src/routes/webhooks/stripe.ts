/**
 * stripe.ts — Inbound webhook handler for Stripe.
 *
 * T-ID: T-9-003
 * Spec: docs/40-integrations/09-stripe-webhook.md
 * Contracts: docs/30-contracts/04-webhook-contracts.md
 *
 * Mounted at POST /v1/webhook/stripe by apps/edge/src/index.ts.
 * This handler is server-to-server — does NOT use authPublicToken or
 * corsMiddleware. Authentication is via Stripe-Signature header, validated
 * in constant time against STRIPE_WEBHOOK_SECRET.
 *
 * Flow:
 *   1. Read raw body text BEFORE parse — CRITICAL for signature (BR-WEBHOOK-001)
 *   2. Resolve workspace via query param ?workspace=<slug>
 *   3. Read STRIPE_WEBHOOK_SECRET from workspace config or binding fallback
 *   4. Validate Stripe-Signature header via verifyStripeSignature()
 *      — includes ADR-022 anti-replay timestamp tolerance (5min)
 *   5. Parse JSON body as StripeEvent
 *   6. Skip subscription events (Phase 3+) → 200
 *   7. Map event to internal via mapStripeToInternal()
 *   8. Error result → persist as failed → 200 (BR-WEBHOOK-003)
 *   9. Persist raw_event as pending (BR-EVENT-001 / INV-EVENT-005)
 *  10. Enqueue to QUEUE_EVENTS → 202
 *
 * BRs applied:
 *   BR-WEBHOOK-001: raw body read before parse; sig validated in constant time
 *   BR-WEBHOOK-002: event_id derived deterministically (sha256("stripe:" + event.id)[:32])
 *   BR-WEBHOOK-003: non-mappable events → raw_events.processing_status='failed' + 200
 *   BR-WEBHOOK-004: lead_hints hierarchy in mapper
 *   BR-PRIVACY-001: email, phone, name, secret never logged; PII hashed by processor
 *   BR-EVENT-001: raw_events insert awaited before 202
 *   ADR-022: timestamp tolerance 5min for anti-replay
 */

import type { Db } from '@globaltracker/db';
import { rawEvents, workspaces } from '@globaltracker/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { mapStripeToInternal } from '../../integrations/stripe/mapper.js';
import type { StripeEvent } from '../../integrations/stripe/types.js';
import { jsonb } from '../../lib/jsonb-cast.js';
import { safeLog } from '../../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

type AppBindings = {
  QUEUE_EVENTS: Queue;
  DB?: Fetcher;
  /** Fallback Stripe webhook secret when workspace config does not have one */
  STRIPE_WEBHOOK_SECRET?: string;
};

type AppEnv = { Bindings: AppBindings };

// ---------------------------------------------------------------------------
// Stripe signature verification
// ---------------------------------------------------------------------------

/**
 * Compares two hex strings in constant time by hashing both values with
 * SHA-256 and XOR-ing the result bytes.
 *
 * BR-WEBHOOK-001: timing-safe comparison prevents HMAC oracle attacks.
 * We cannot use Node's crypto.timingSafeEqual in Workers; this is the
 * portable Web Crypto equivalent.
 */
async function timingSafeHexEqual(a: string, b: string): Promise<boolean> {
  // Length inequality is not secret — Stripe signatures are always 64 hex chars.
  // We still hash both to keep compute time constant.
  if (a.length !== b.length) {
    const enc = new TextEncoder();
    await crypto.subtle.digest('SHA-256', enc.encode(a));
    return false;
  }
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const av = new Uint8Array(ah);
  const bv = new Uint8Array(bh);
  let diff = 0;
  for (let i = 0; i < av.length; i++) {
    diff |= (av[i] ?? 0) ^ (bv[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Verifies a Stripe webhook signature.
 *
 * Stripe algorithm:
 *   1. Parse Stripe-Signature header: t=<timestamp>,v1=<hmac_hex>
 *   2. Signed payload: `${timestamp}.${rawBody}`
 *   3. HMAC-SHA256(signed_payload, STRIPE_WEBHOOK_SECRET)
 *   4. Compare computed hex with v1 in constant time
 *
 * BR-WEBHOOK-001: raw body must be used, NOT parsed JSON.
 * ADR-022: timestamp within toleranceSeconds (default 300 = 5min) prevents replay.
 *
 * @param rawBody - Raw request body text (read before JSON.parse)
 * @param sigHeader - Value of Stripe-Signature header
 * @param secret - STRIPE_WEBHOOK_SECRET for this endpoint
 * @param toleranceSeconds - Max age of event (default 300 = 5min per ADR-022)
 * @returns true if signature is valid and timestamp is within tolerance
 */
export async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  secret: string,
  toleranceSeconds = 300,
): Promise<boolean> {
  // Parse header: "t=<timestamp>,v1=<hmac_hex>[,v1=<hmac_hex2>...]"
  const parts: Record<string, string> = {};
  for (const part of sigHeader.split(',')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx);
    const v = part.slice(eqIdx + 1);
    // Last value wins (Stripe sends multiple v1 during secret rotation)
    parts[k] = v;
  }

  const timestamp = parts['t'];
  const v1 = parts['v1'];

  if (!timestamp || !v1) return false;

  // ADR-022: anti-replay — timestamp must be within toleranceSeconds of now
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(now - ts) > toleranceSeconds) return false;

  // HMAC-SHA256 via Web Crypto
  // BR-WEBHOOK-001: signed payload = "${timestamp}.${rawBody}" per Stripe spec
  const enc = new TextEncoder();
  const payload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const computed = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  // BR-WEBHOOK-001: timing-safe comparison
  return timingSafeHexEqual(computed, v1);
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the Stripe webhook sub-router.
 *
 * @param db - Drizzle DB instance; undefined in tests without DB
 */
export function createStripeWebhookRoute(db?: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/', async (c) => {
    // -----------------------------------------------------------------------
    // Step 1: Read raw body BEFORE any parse
    // BR-WEBHOOK-001: Stripe signature is computed over raw body.
    // Parsing JSON first changes the byte representation and breaks signature.
    // -----------------------------------------------------------------------
    let rawBody: string;
    try {
      rawBody = await c.req.raw.text();
    } catch {
      return c.json({ error: 'bad_request' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 2: Resolve workspace via ?workspace=<slug>
    // -----------------------------------------------------------------------
    const workspaceSlug = c.req.query('workspace');
    if (!workspaceSlug) {
      return c.json({ error: 'missing_workspace' }, 400);
    }

    let workspaceId: string | null = null;
    let stripeWebhookSecret: string | null = null;

    if (db) {
      try {
        const workspace = await db.query.workspaces.findFirst({
          where: eq(workspaces.slug, workspaceSlug),
        });

        if (workspace) {
          workspaceId = workspace.id;
          // Read secret from workspace.config.integrations.stripe.webhook_secret
          // with fallback to binding STRIPE_WEBHOOK_SECRET
          const config = workspace.config as Record<string, unknown> | null;
          const integrations = config?.['integrations'] as Record<string, unknown> | undefined;
          const stripeConfig = integrations?.['stripe'] as Record<string, unknown> | undefined;
          const configSecret = stripeConfig?.['webhook_secret'];
          stripeWebhookSecret =
            typeof configSecret === 'string' ? configSecret : null;
        }
      } catch (err) {
        safeLog('error', {
          event: 'stripe_webhook_db_lookup_error',
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        return c.json({ error: 'internal_error' }, 500);
      }
    }

    // Fallback to binding when workspace config has no secret or DB is unavailable
    const secret =
      stripeWebhookSecret ?? c.env.STRIPE_WEBHOOK_SECRET ?? null;

    if (!secret) {
      safeLog('warn', {
        event: 'stripe_webhook_no_secret_configured',
        workspace_slug: workspaceSlug,
      });
      return c.json({ error: 'unauthorized' }, 400);
    }

    if (!workspaceId) {
      // Workspace not found — do not hint at existence
      return c.json({ error: 'unauthorized' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 3: Validate Stripe-Signature header
    // BR-WEBHOOK-001: timing-safe comparison + ADR-022 timestamp tolerance
    // BR-PRIVACY-001: never log signature header value
    // -----------------------------------------------------------------------
    const sigHeader = c.req.header('stripe-signature');
    if (!sigHeader) {
      safeLog('warn', {
        event: 'stripe_webhook_missing_signature',
        workspace_id: workspaceId,
      });
      return c.json({ error: 'invalid_signature' }, 400);
    }

    let signatureValid: boolean;
    try {
      signatureValid = await verifyStripeSignature(rawBody, sigHeader, secret);
    } catch (err) {
      safeLog('error', {
        event: 'stripe_webhook_signature_verify_error',
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
      return c.json({ error: 'internal_error' }, 500);
    }

    if (!signatureValid) {
      safeLog('warn', {
        event: 'stripe_webhook_signature_invalid',
        workspace_id: workspaceId,
      });
      return c.json({ error: 'invalid_signature' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 4: Parse JSON body as StripeEvent
    // CRITICAL: only after signature validation
    // -----------------------------------------------------------------------
    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody) as StripeEvent;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 5: Skip subscription events (Phase 3+) → 200
    // Spec: customer.subscription.deleted and customer.subscription.created
    // are Fase 3+ — accepted but not processed now.
    // BR-WEBHOOK-003: return 200 (not 4xx) so Stripe stops retrying.
    // -----------------------------------------------------------------------
    if (
      event.type === 'customer.subscription.deleted' ||
      event.type === 'customer.subscription.created'
    ) {
      safeLog('info', {
        event: 'stripe_webhook_subscription_skipped',
        workspace_id: workspaceId,
        stripe_event_type: event.type,
      });
      // Persist as discarded so we have an audit trail
      if (db) {
        try {
          await db.insert(rawEvents).values({
            workspaceId,
            payload: jsonb({ stripe_event_id: event.id, stripe_event_type: event.type }),
            headersSanitized: jsonb({}),
            processingStatus: 'discarded',
            processingError: `subscription events deferred to Phase 3+: ${event.type}`,
          });
        } catch {
          // Best-effort; subscription events are intentionally skipped
        }
      }
      return c.json({ received: true }, 200);
    }

    // -----------------------------------------------------------------------
    // Step 6: Map event to internal
    // -----------------------------------------------------------------------
    const mapResult = await mapStripeToInternal(event);

    // -----------------------------------------------------------------------
    // Step 7: Handle mapping error — persist as failed
    // BR-WEBHOOK-003: non-mappable → processing_status='failed' + 200
    // -----------------------------------------------------------------------
    if (!mapResult.ok) {
      const errorCode = mapResult.error.code;

      safeLog('warn', {
        event: 'stripe_webhook_mapping_failed',
        workspace_id: workspaceId,
        stripe_event_type: event.type,
        error_code: errorCode,
      });

      if (db) {
        try {
          await db.insert(rawEvents).values({
            workspaceId,
            // BR-PRIVACY-001: store only non-PII identifiers, not full payload
            payload: jsonb({ stripe_event_id: event.id, stripe_event_type: event.type }),
            headersSanitized: jsonb({}),
            processingStatus: 'failed',
            processingError: `mapping_failed:${errorCode}`,
          });
        } catch (err) {
          safeLog('error', {
            event: 'stripe_webhook_failed_insert_error',
            workspace_id: workspaceId,
            error_type: err instanceof Error ? err.constructor.name : 'unknown',
          });
        }
      }

      // BR-WEBHOOK-003: return 200 (not 4xx/5xx) so Stripe does not retry forever
      return c.json({ received: true }, 200);
    }

    // -----------------------------------------------------------------------
    // Step 8: Persist raw_event with processing_status='pending'
    // BR-EVENT-001: insert awaited before returning 202
    // INV-EVENT-005: Edge persists in raw_events before returning 202
    // BR-PRIVACY-001: store only non-PII event envelope, not raw customer details
    // -----------------------------------------------------------------------
    const internalEvent = mapResult.value;
    let rawEventId: string | undefined;

    if (db) {
      const storedPayload: Record<string, unknown> = {
        // Non-PII Stripe envelope
        stripe_event_id: event.id,
        stripe_event_type: event.type,
        stripe_created: event.created,
        // Derived internal fields for processor convenience
        _stripe_event_id: internalEvent.event_id,
        _stripe_event_type: internalEvent.event_type,
        // Monetary data (non-PII)
        ...(internalEvent.amount != null && { amount: internalEvent.amount }),
        ...(internalEvent.currency != null && { currency: internalEvent.currency }),
        // Lead hints included so processor can resolve lead without re-parsing
        // BR-PRIVACY-001: processor hashes PII before writing to lead_aliases
        lead_hints: internalEvent.lead_hints,
        ...(internalEvent.attribution != null && {
          attribution: internalEvent.attribution,
        }),
        ...(internalEvent.custom_data != null && {
          custom_data: internalEvent.custom_data,
        }),
      };

      try {
        const inserted = await db
          .insert(rawEvents)
          .values({
            workspaceId,
            payload: jsonb(storedPayload),
            headersSanitized: jsonb({}),
            processingStatus: 'pending',
          })
          .returning({ id: rawEvents.id });

        rawEventId = inserted[0]?.id;
      } catch (err) {
        safeLog('error', {
          event: 'stripe_webhook_insert_failed',
          workspace_id: workspaceId,
          event_id: internalEvent.event_id,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        // BR-EVENT-001 / INV-EVENT-005: if insert fails, return 500 so Stripe retries
        return c.json({ error: 'internal_error' }, 500);
      }
    }

    // -----------------------------------------------------------------------
    // Step 9: Enqueue to QUEUE_EVENTS for async ingestion
    // -----------------------------------------------------------------------
    try {
      await c.env.QUEUE_EVENTS.send({
        raw_event_id: rawEventId,
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        event_type: internalEvent.event_type,
        platform: 'stripe',
      });
    } catch (err) {
      // Queue error — raw_events already persisted; log and continue
      // (at-least-once: processor can pick up from raw_events)
      safeLog('error', {
        event: 'stripe_webhook_enqueue_failed',
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }

    safeLog('info', {
      event: 'stripe_webhook_accepted',
      workspace_id: workspaceId,
      event_id: internalEvent.event_id,
      event_type: internalEvent.event_type,
      platform_event_id: internalEvent.platform_event_id,
    });

    return c.json({ received: true }, 202);
  });

  return router;
}

/**
 * Default export for mounting in index.ts.
 * To wire DB, use createStripeWebhookRoute(db) instead.
 */
export const stripeWebhookRoute = createStripeWebhookRoute();
