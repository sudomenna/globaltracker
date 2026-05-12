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
 *      OnProfit não implementa HMAC — workspace slug é o único mecanismo de auth.
 *   3. Parse JSON body.
 *   4. Call mapper.
 *   5. Skip → 202 (no insert).
 *   6. Mapping error → persist as failed → 200 (BR-WEBHOOK-003).
 *   7. Persist as pending in raw_events with derived fields injected.
 *   8. Enqueue → 202.
 *
 * BRs applied:
 *   BR-WEBHOOK-001: server-to-server isolation; OnProfit não implementa HMAC (confirmado 2026-05-11)
 *   BR-WEBHOOK-002: event_id derived deterministically (in mapper)
 *   BR-WEBHOOK-003: non-mappable / unknown statuses → raw_events failed + 200
 *   BR-WEBHOOK-004: lead_hints hierarchy populated by mapper
 *   BR-PRIVACY-001: customer email/phone/name never logged; payload stored as-is
 *                   (processor hashes before persisting in lead_aliases)
 *   BR-EVENT-001: raw_events insert awaited before 202
 *   INV-EVENT-005: Edge persists raw_event before returning 202
 */

import type { Db } from '@globaltracker/db';
import { events, leadAliases, rawEvents, workspaces } from '@globaltracker/db';
import { and, eq, gt } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  mapOnProfitCartAbandonmentToInternal,
  mapOnProfitToInternal,
} from '../../integrations/onprofit/mapper.js';
import type {
  OnProfitCartAbandonmentPayload,
  OnProfitWebhookPayload,
} from '../../integrations/onprofit/types.js';
import {
  buildFbcFromFbclid,
  extractUtmsFromUrl,
} from '../../integrations/shared/cart-abandonment.js';
import { jsonb } from '../../lib/jsonb-cast.js';
import { resolveLaunchForOnProfitEvent } from '../../lib/onprofit-launch-resolver.js';
import { hashPii } from '../../lib/pii.js';
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
    // Step 1: Read raw body text BEFORE any parse (BR-WEBHOOK-001).
    // -----------------------------------------------------------------------
    let rawBodyText: string;
    try {
      rawBodyText = await c.req.raw.text();
    } catch {
      return c.json({ error: 'bad_request' }, 400);
    }

    // Capture non-sensitive headers for observability.
    // Note: OnProfit does not implement HMAC/signature headers (confirmed
    // 2026-05-11 by inspecting real payloads via n8n mirror). Auth is
    // workspace slug in query string only.
    const capturedHeaders: Record<string, string> = {};
    for (const [k, v] of c.req.raw.headers.entries()) {
      const lower = k.toLowerCase();
      if (lower === 'authorization' || lower === 'cookie') continue;
      capturedHeaders[lower] = v;
    }

    // -----------------------------------------------------------------------
    // Step 2: Resolve workspace by ?workspace=<slug>.
    // -----------------------------------------------------------------------

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
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(rawBodyText);
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    // -----------------------------------------------------------------------
    // Step 3.5: Branch by object type.
    //
    // OnProfit sends two distinct webhook shapes:
    //   - object: "order"            → order lifecycle (PAID, WAITING, …)
    //   - object: "cart_abandonment" → buyer left checkout before paying
    //
    // Cart abandonment is handled first because it has a completely different
    // field layout (no status, no price at root, customer.last_name, UTMs in URL).
    // -----------------------------------------------------------------------
    const objectType =
      typeof rawBody === 'object' &&
      rawBody !== null &&
      'object' in (rawBody as Record<string, unknown>)
        ? (rawBody as Record<string, unknown>).object
        : undefined;

    if (objectType === 'cart_abandonment') {
      return handleCartAbandonment(
        rawBody as OnProfitCartAbandonmentPayload,
        workspaceId,
        db,
        c,
      );
    }

    const body = rawBody as OnProfitWebhookPayload;

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
            headersSanitized: jsonb(capturedHeaders),
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

    // -----------------------------------------------------------------------
    // Step 6.5: Resolve launch_id + funnel_role (ONPROFIT-LAUNCH-RESOLVER-TODO).
    // Mirror estrutural do passo equivalente em createGuruWebhookRoute.
    // Falha não-fatal: raw_event ainda é persistido sem launch_id; processor
    // segue sem lead_stages/tag_rules nesse caso.
    // BR-PRIVACY-001: leadHints (email/phone) NÃO entram em logs.
    // -----------------------------------------------------------------------
    let resolvedLaunchId: string | null = null;
    let resolvedFunnelRole: string | null = null;
    if (db) {
      const productId =
        body.product?.id != null ? String(body.product.id) : null;
      try {
        const resolved = await resolveLaunchForOnProfitEvent({
          workspaceId,
          productId,
          leadHints: {
            email: internalEvent.lead_hints.email,
            phone: internalEvent.lead_hints.phone,
            visitorId: null,
          },
          db,
        });
        resolvedLaunchId = resolved.launch_id;
        resolvedFunnelRole = resolved.funnel_role;
      } catch (err) {
        safeLog('warn', {
          event: 'onprofit_webhook_launch_resolution_failed',
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
      }
    }

    // Build enriched payload — sanitized body + derived fields the processor
    // uses to short-circuit re-mapping. BR-PRIVACY-001: customer.email/phone/
    // name remain in payload for processor; never written to log columns.
    const enrichedPayload: Record<string, unknown> = {
      ...sanitizePayloadForStorage(body),
      _onprofit_event_type: internalEvent.event_type,
      _onprofit_event_id: internalEvent.event_id,
      ...(resolvedLaunchId !== null && { launch_id: resolvedLaunchId }),
      ...(resolvedFunnelRole !== null && { funnel_role: resolvedFunnelRole }),
    };

    let rawEventId: string | undefined;

    if (db) {
      try {
        const inserted = await db
          .insert(rawEvents)
          .values({
            workspaceId,
            payload: jsonb(enrichedPayload),
            headersSanitized: jsonb(capturedHeaders),
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
// Cart abandonment handler
//
// Extracted as a named function so the main route handler stays readable.
// Mirrors the order flow but with field normalization so the existing
// onprofit-raw-events-processor can consume the payload without changes:
//   - `price`       ← offer_details.price   (centavos, processor divides by 100)
//   - `currency`    ← 'BRL'                 (not present in abandonment payload)
//   - `status`      ← 'CART_ABANDONED'       (synthetic; processor stores as-is)
//   - `customer.lastname` ← customer.last_name (field rename)
//   - `utm_source/…`      ← parsed from url query string
//   - `fbc`               ← derived from fbclid when present
//   - `purchase_date`     ← created_at
//   - `product`           ← from product_details / product_id
//   - `offer_hash`        ← from product_details.hash (for transaction_group_id)
//   - `item_type`         ← 'product' (no order bumps on abandonment)
// ---------------------------------------------------------------------------

async function handleCartAbandonment(
  body: OnProfitCartAbandonmentPayload,
  workspaceId: string,
  db: Db | undefined,
  c: Context<AppEnv>,
): Promise<Response> {
  const mapResult = await mapOnProfitCartAbandonmentToInternal(body);

  if (!mapResult.ok) {
    if ('skip' in mapResult && mapResult.skip) {
      safeLog('info', {
        event: 'onprofit_cart_abandonment_skipped',
        workspace_id: workspaceId,
        reason: mapResult.reason,
      });
      return c.json({ received: true }, 202);
    }

    safeLog('warn', {
      event: 'onprofit_cart_abandonment_mapping_failed',
      workspace_id: workspaceId,
      error_code: mapResult.error.code,
    });

    if (db) {
      try {
        await db.insert(rawEvents).values({
          workspaceId,
          payload: jsonb(body as unknown as Record<string, unknown>),
          headersSanitized: jsonb({}),
          processingStatus: 'failed',
          processingError: `cart_abandonment_mapping_failed:${mapResult.error.code}`,
        });
      } catch {
        // best-effort
      }
    }
    return c.json({ received: true }, 200);
  }

  const internalEvent = mapResult.value;

  // Resolve launch_id the same way the order flow does (product_id lookup)
  let resolvedLaunchId: string | null = null;
  let resolvedFunnelRole: string | null = null;
  if (db) {
    const productId =
      body.product_details?.id != null
        ? String(body.product_details.id)
        : body.product_id != null
          ? String(body.product_id)
          : null;
    try {
      const resolved = await resolveLaunchForOnProfitEvent({
        workspaceId,
        productId,
        leadHints: {
          email: internalEvent.lead_hints.email,
          phone: internalEvent.lead_hints.phone,
          visitorId: null,
        },
        db,
      });
      resolvedLaunchId = resolved.launch_id;
      resolvedFunnelRole = resolved.funnel_role;
    } catch (err) {
      safeLog('warn', {
        event: 'onprofit_cart_abandonment_launch_resolution_failed',
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }
  }

  // Suppress dispatch when a Purchase already exists for this email+launch in the
  // last 6h — the user already converted; firing InitiateCheckout would distort ROAS.
  // Best-effort: suppression failure is non-fatal and proceeds to normal processing.
  let suppressedByPurchase = false;
  if (db && internalEvent.lead_hints.email) {
    try {
      const emailHash = await hashPii(
        internalEvent.lead_hints.email.toLowerCase().trim(),
        workspaceId,
      );
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const existing = await db
        .select({ id: events.id })
        .from(events)
        .innerJoin(leadAliases, eq(leadAliases.leadId, events.leadId))
        .where(
          and(
            eq(events.workspaceId, workspaceId),
            eq(events.eventName, 'Purchase'),
            gt(events.eventTime, sixHoursAgo),
            eq(leadAliases.workspaceId, workspaceId),
            eq(leadAliases.identifierType, 'email_hash'),
            eq(leadAliases.identifierHash, emailHash),
            eq(leadAliases.status, 'active'),
            ...(resolvedLaunchId ? [eq(events.launchId, resolvedLaunchId)] : []),
          ),
        )
        .limit(1);
      suppressedByPurchase = existing.length > 0;
    } catch {
      // suppression check failure → proceed normally
    }
  }

  // Normalize into the shape the existing processor expects
  const urlUtms = extractUtmsFromUrl(body.url);
  const fbc =
    internalEvent.meta_cookies?.fbc ??
    (urlUtms.fbclid
      ? buildFbcFromFbclid(urlUtms.fbclid, internalEvent.occurred_at)
      : null);

  const enrichedPayload: Record<string, unknown> = {
    ...(body as unknown as Record<string, unknown>),
    // Processor-compatibility normalization
    status: 'CART_ABANDONED',
    price: body.offer_details?.price ?? 0,
    currency: 'BRL',
    purchase_date: body.created_at ?? null,
    confirmation_purchase_date: null,
    // Normalize customer field names to match order payload shape
    customer: {
      ...body.customer,
      lastname: body.customer.last_name,
      cell: null,
    },
    // Flattened UTMs (parsed from URL)
    utm_source: urlUtms.utm_source,
    utm_medium: urlUtms.utm_medium,
    utm_campaign: urlUtms.utm_campaign,
    utm_content: urlUtms.utm_content,
    utm_term: urlUtms.utm_term,
    // Meta cookies
    fbc,
    fbp: null,
    // Product/offer fields mirroring order payload shape
    product:
      body.product_details != null
        ? { id: body.product_details.id, name: body.product_details.name }
        : body.product_id != null
          ? { id: body.product_id, name: null }
          : null,
    offer_hash: body.product_details?.hash ?? null,
    offer_name: body.offer_details?.name ?? null,
    offer_id: body.offer_details?.id ?? body.offer_id ?? null,
    item_type: 'product', // no order bumps on cart abandonment
    // Derived event metadata (read by processor)
    _onprofit_event_type: 'InitiateCheckout',
    _onprofit_event_id: internalEvent.event_id,
    ...(resolvedLaunchId !== null && { launch_id: resolvedLaunchId }),
    ...(resolvedFunnelRole !== null && { funnel_role: resolvedFunnelRole }),
  };

  if (db) {
    if (suppressedByPurchase) {
      try {
        await db.insert(rawEvents).values({
          workspaceId,
          payload: jsonb(enrichedPayload),
          headersSanitized: jsonb({}),
          processingStatus: 'discarded',
          processingError: 'suppressed_by_purchase',
        });
      } catch {
        // best-effort audit trail
      }
      safeLog('info', {
        event: 'onprofit_cart_abandonment_suppressed',
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
      });
      return c.json({ received: true }, 202);
    }

    let rawEventId: string | undefined;
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
        event: 'onprofit_cart_abandonment_insert_failed',
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }

    try {
      await c.env.QUEUE_EVENTS.send({
        raw_event_id: rawEventId,
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        event_type: internalEvent.event_type,
        platform: 'onprofit',
      });
    } catch (err) {
      safeLog('error', {
        event: 'onprofit_cart_abandonment_enqueue_failed',
        workspace_id: workspaceId,
        event_id: internalEvent.event_id,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }
  }

  safeLog('info', {
    event: 'onprofit_cart_abandonment_received',
    workspace_id: workspaceId,
    event_id: internalEvent.event_id,
  });

  return c.json({ received: true }, 202);
}

// ---------------------------------------------------------------------------
// Default export for direct mounting in tests / index.ts without DB
// ---------------------------------------------------------------------------

export const onprofitWebhookRoute = createOnprofitWebhookRoute();
