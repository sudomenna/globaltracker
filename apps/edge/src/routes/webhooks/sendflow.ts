/**
 * sendflow.ts — Inbound webhook handler for SendFlow (WhatsApp group manager).
 *
 * T-ID: T-13-011 (Sprint 13)
 * Reference: ~/.claude/projects/.../memory/reference_sendflow.md
 *
 * Mounted at POST /v1/webhooks/sendflow by apps/edge/src/index.ts.
 * Server-to-server — no public auth/CORS. Authentication is via the `sendtok`
 * HTTP header validated in constant time against
 * `workspace_integrations.sendflow_sendtok` (migration 0035).
 *
 * Payload (observed via webhook.site capture, 2026-05-05):
 *   {
 *     "id": "RMo0copmEJMTdZXhEGVU",                       // idempotency key
 *     "event": "group.updated.members.added"               // or .removed
 *           | "group.updated.members.removed",
 *     "data": {
 *       "campaignId": "0b4IxLZFiYOxxRyO6ZmE",              // map → launch+stage
 *       "campaignName": "...",
 *       "groupName": "...",
 *       "groupJid": "...",
 *       "groupId": "...",
 *       "number": "5511988887777",                          // phone (variable format — T-13-014 normalizes)
 *       "createdAt": "2026-05-05T08:27:15.470Z",
 *       "createdAt_with_timezone_br": "2026-05-05T05:27:15.470-03:00"
 *     },
 *     "version": "1.0.0"
 *   }
 *
 * Auth header (NOT Authorization/Bearer — note unusual lowercase custom header):
 *   sendtok: ADF590B72BCFCB64E98982B73C9ECB613A30DC5EC9
 *
 * Decision (Tiago, 2026-05-05): one launch may have multiple SendFlow campaigns
 * mapping to distinct funnel stages. For wkshop-cs-jun26:
 *   campaign_id 3bhG8XexRRKwLxF4SGtk (Compradores Workshop)         → stage wpp_joined,         event_name "Contact"
 *   campaign_id 0b4IxLZFiYOxxRyO6ZmE (VIP Interessados Main Offer) → stage wpp_joined_vip_main, event_name "custom:wpp_joined_vip_main"
 *
 * Mapping is stored in `workspaces.config.sendflow.campaign_map`:
 *   { "<campaignId>": { "launch": "<public_id>", "stage": "<slug>", "event_name": "<canonical-or-custom>" } }
 *
 * Flow:
 *   1. Read sendtok header → 401 if missing
 *   2. Constant-time lookup workspace_id by sendflow_sendtok
 *   3. Parse JSON body via Zod
 *   4. Resolve campaign_map[campaignId] → { launch, stage, event_name }
 *      → 200 with warning if campaign unknown (not 4xx — SendFlow shouldn't retry)
 *   5. members.removed → event_name override = "custom:wpp_left" (no stage; tracked event)
 *   6. Resolve launch.id by public_id
 *   7. normalizePhone(data.number) → BR-aware E.164 (T-13-014)
 *   8. resolveLeadByAliases({phone}, workspace_id)
 *      → if not found, create new anonymous lead with phone alias
 *   9. Insert raw_event (event_id=payload.id, processing_status=pending) with
 *      injected lead_id + launch_id + funnel_role + wpp_campaign_role
 *      Pre-insert dedup (events table is partitioned, INSERT…ON CONFLICT
 *      doesn't trigger — same fix pattern as guru-raw-events-processor)
 *  10. Enqueue → 202
 *
 * BRs applied:
 *   BR-WEBHOOK-001: token validated before processing (constant-time comparison)
 *   BR-WEBHOOK-002: event_id derived deterministically (payload.id)
 *   BR-WEBHOOK-003: non-mappable events → raw_events.processing_status='failed' + 200
 *   BR-PRIVACY-001: sendtok, phone never logged
 *   BR-EVENT-001: raw_events insert awaited before 202
 *   BR-IDENTITY-002: phone normalized via T-13-014 before hashing
 *   INV-IDENTITY-008: BR mobile canônico = 13 dígitos com 9; landline = 12
 */

import type { Db } from '@globaltracker/db';
import {
  events,
  launches,
  rawEvents,
  workspaceIntegrations,
  workspaces,
} from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { normalizePhone, resolveLeadByAliases } from '../../lib/lead-resolver.js';
import { enrichLeadPii } from '../../lib/pii-enrich.js';
import { safeLog } from '../../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

type AppBindings = {
  QUEUE_EVENTS: Queue;
  PII_MASTER_KEY_V1?: string;
};

type AppEnv = { Bindings: AppBindings };

// ---------------------------------------------------------------------------
// Payload schema
// ---------------------------------------------------------------------------

const SendflowEventTypeSchema = z.enum([
  'group.updated.members.added',
  'group.updated.members.removed',
]);

export const SendflowDataSchema = z
  .object({
    campaignId: z.string().min(1),
    campaignName: z.string().nullish(),
    groupName: z.string().nullish(),
    groupJid: z.string().nullish(),
    groupId: z.string().nullish(),
    number: z.string().min(1),
    createdAt: z.string(),
    createdAt_with_timezone_br: z.string().nullish(),
  })
  .passthrough();

export const SendflowPayloadSchema = z
  .object({
    id: z.string().min(1).max(64),
    event: SendflowEventTypeSchema,
    data: SendflowDataSchema,
    version: z.string().nullish(),
  })
  .passthrough();

export type SendflowPayload = z.infer<typeof SendflowPayloadSchema>;

// `workspaces.config.sendflow.campaign_map` shape (lookup-only on Edge).
type CampaignMapEntry = {
  launch: string;
  stage: string;
  event_name: string;
};

// ---------------------------------------------------------------------------
// Constant-time token comparison (mirrors guru.ts)
// ---------------------------------------------------------------------------

async function timingSafeTokenEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (a.length !== b.length) {
    await crypto.subtle.digest('SHA-256', aBytes);
    return false;
  }
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', aBytes),
    crypto.subtle.digest('SHA-256', bBytes),
  ]);
  const aView = new Uint8Array(aHash);
  const bView = new Uint8Array(bHash);
  let diff = 0;
  for (let i = 0; i < aView.length; i++) {
    diff |= (aView[i] ?? 0) ^ (bView[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

type DbOrFactory = Db | ((env: AppBindings) => Db);

export function createSendflowWebhookRoute(
  dbOrFactory?: DbOrFactory,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/', async (c) => {
    const db =
      typeof dbOrFactory === 'function' ? dbOrFactory(c.env) : dbOrFactory;

    // -----------------------------------------------------------------------
    // Step 1: Read sendtok header
    // BR-PRIVACY-001: never log header value.
    // -----------------------------------------------------------------------
    const receivedToken = c.req.header('sendtok') ?? '';
    if (!receivedToken) {
      safeLog('warn', { event: 'sendflow_webhook_missing_token' });
      return c.json({ error: 'unauthorized' }, 401);
    }

    // -----------------------------------------------------------------------
    // Step 2: Resolve workspace via constant-time comparison
    // -----------------------------------------------------------------------
    let workspaceId: string | null = null;

    if (db) {
      try {
        const integration = await db.query.workspaceIntegrations.findFirst({
          where: eq(workspaceIntegrations.sendflowSendtok, receivedToken),
        });
        if (integration) {
          const stored = integration.sendflowSendtok ?? '';
          if (await timingSafeTokenEqual(receivedToken, stored)) {
            workspaceId = integration.workspaceId;
          }
        }
      } catch (err) {
        safeLog('error', {
          event: 'sendflow_webhook_db_auth_error',
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        return c.json({ error: 'internal_error' }, 500);
      }
    }

    if (!workspaceId) {
      // BR-PRIVACY-001: no info leak about token existence.
      return c.json({ error: 'unauthorized' }, 401);
    }

    // -----------------------------------------------------------------------
    // Step 3: Parse + validate body
    // -----------------------------------------------------------------------
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    const parsed = SendflowPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      safeLog('warn', {
        event: 'sendflow_webhook_invalid_payload',
        workspace_id: workspaceId,
        issues_count: parsed.error.issues.length,
      });
      // BR-WEBHOOK-003: store as failed for forensics, return 200.
      if (db) {
        try {
          await db.insert(rawEvents).values({
            workspaceId,
            payload: { _provider: 'sendflow', _validation_error: true, raw },
            headersSanitized: {},
            processingStatus: 'failed',
            processingError: 'sendflow_payload_validation_failed',
          });
        } catch {
          /* best-effort */
        }
      }
      return c.json({ received: true }, 200);
    }

    const payload = parsed.data;

    // -----------------------------------------------------------------------
    // Step 4: Resolve campaign → { launch, stage, event_name }
    // -----------------------------------------------------------------------
    let campaignEntry: CampaignMapEntry | null = null;

    if (db) {
      try {
        const ws = await db.query.workspaces.findFirst({
          where: eq(workspaces.id, workspaceId),
          columns: { config: true },
        });
        const cfg = (ws?.config ?? {}) as Record<string, unknown>;
        const sf = (cfg.sendflow ?? {}) as Record<string, unknown>;
        const map = (sf.campaign_map ?? {}) as Record<string, unknown>;
        const entry = map[payload.data.campaignId];
        if (entry && typeof entry === 'object') {
          const e = entry as Record<string, unknown>;
          if (
            typeof e.launch === 'string' &&
            typeof e.stage === 'string' &&
            typeof e.event_name === 'string'
          ) {
            campaignEntry = {
              launch: e.launch,
              stage: e.stage,
              event_name: e.event_name,
            };
          }
        }
      } catch (err) {
        safeLog('error', {
          event: 'sendflow_webhook_config_lookup_error',
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
      }
    }

    if (!campaignEntry) {
      // BR-WEBHOOK-003: unknown campaign → store failed + 200 (don't retry).
      safeLog('warn', {
        event: 'sendflow_webhook_unknown_campaign',
        workspace_id: workspaceId,
        campaign_id: payload.data.campaignId,
        sendflow_event_id: payload.id,
      });
      if (db) {
        try {
          await db.insert(rawEvents).values({
            workspaceId,
            payload: { _provider: 'sendflow', ...payload },
            headersSanitized: {},
            processingStatus: 'failed',
            processingError: `unknown_campaign:${payload.data.campaignId}`,
          });
        } catch {
          /* best-effort */
        }
      }
      return c.json({ received: true }, 200);
    }

    // -----------------------------------------------------------------------
    // Step 5: Override event_name for `members.removed`
    // members.removed → custom:wpp_left (no stage transition, just tracked
    // for future churn audience). Decision Tiago 2026-05-05.
    // -----------------------------------------------------------------------
    const eventName =
      payload.event === 'group.updated.members.removed'
        ? 'custom:wpp_left'
        : campaignEntry.event_name;

    // -----------------------------------------------------------------------
    // Step 6: Resolve launch.id by public_id (FK to events.launch_id)
    // -----------------------------------------------------------------------
    let launchId: string | null = null;
    if (db) {
      try {
        const launch = await db.query.launches.findFirst({
          where: and(
            eq(launches.workspaceId, workspaceId),
            eq(launches.publicId, campaignEntry.launch),
          ),
          columns: { id: true },
        });
        launchId = launch?.id ?? null;
      } catch (err) {
        safeLog('error', {
          event: 'sendflow_webhook_launch_lookup_failed',
          workspace_id: workspaceId,
          launch_public_id: campaignEntry.launch,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
      }
    }

    // -----------------------------------------------------------------------
    // Step 7: Normalize phone (T-13-014 BR-aware) + resolve/create lead
    // -----------------------------------------------------------------------
    const normalizedPhone = normalizePhone(payload.data.number);
    if (!normalizedPhone) {
      safeLog('warn', {
        event: 'sendflow_webhook_phone_normalize_failed',
        workspace_id: workspaceId,
        sendflow_event_id: payload.id,
        // BR-PRIVACY-001: phone value never logged
      });
      if (db) {
        try {
          await db.insert(rawEvents).values({
            workspaceId,
            payload: { _provider: 'sendflow', ...payload },
            headersSanitized: {},
            processingStatus: 'failed',
            processingError: 'phone_normalize_failed',
          });
        } catch {
          /* best-effort */
        }
      }
      return c.json({ received: true }, 200);
    }

    let leadId: string | null = null;
    if (db) {
      const resolveResult = await resolveLeadByAliases(
        { phone: normalizedPhone },
        workspaceId,
        db,
      );
      if (!resolveResult.ok) {
        safeLog('error', {
          event: 'sendflow_webhook_lead_resolve_failed',
          workspace_id: workspaceId,
          error_code: resolveResult.error.code,
        });
      } else {
        leadId = resolveResult.value.lead_id;

        // T-13-015: enrich lead PII so admin can recover phone.
        try {
          await enrichLeadPii(
            { phone: normalizedPhone },
            {
              leadId,
              workspaceId,
              db,
              masterKeyHex: c.env.PII_MASTER_KEY_V1,
            },
          );
        } catch (err) {
          safeLog('warn', {
            event: 'sendflow_webhook_enrich_pii_failed',
            workspace_id: workspaceId,
            lead_id: leadId,
            message: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
    }

    // -----------------------------------------------------------------------
    // Step 8: Pre-insert dedup + insert raw_event (T-FUNIL-047 pattern)
    // events table is partitioned by received_at, so INSERT … ON CONFLICT
    // doesn't deduplicate on retries with different received_at.
    // -----------------------------------------------------------------------
    if (db) {
      // Check if we already accepted this event (idempotency by payload.id).
      try {
        const existing = await db.query.events.findFirst({
          where: and(
            eq(events.workspaceId, workspaceId),
            eq(events.eventId, payload.id),
          ),
          columns: { id: true },
        });
        if (existing) {
          safeLog('info', {
            event: 'sendflow_webhook_duplicate_dropped',
            workspace_id: workspaceId,
            sendflow_event_id: payload.id,
          });
          return c.json({ received: true, duplicate: true }, 202);
        }
      } catch (err) {
        // Non-fatal — proceed with insert and let DB constraint handle if conflict.
        safeLog('warn', {
          event: 'sendflow_webhook_dedup_check_failed',
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
      }

      const enrichedPayload = {
        _provider: 'sendflow',
        ...payload,
        // Derived fields for downstream processor convenience.
        _resolved_event_name: eventName,
        _resolved_stage: payload.event === 'group.updated.members.removed'
          ? null
          : campaignEntry.stage,
        ...(launchId !== null && { launch_id: launchId }),
        ...(leadId !== null && { lead_id: leadId }),
        // wpp_campaign_role for analytics/breadcrumb.
        wpp_campaign_role: payload.event === 'group.updated.members.removed'
          ? 'left'
          : campaignEntry.stage === 'wpp_joined'
            ? 'workshop'
            : 'main_offer_vip',
      };

      try {
        await db.insert(rawEvents).values({
          workspaceId,
          payload: enrichedPayload,
          headersSanitized: { 'user-agent': c.req.header('user-agent') ?? '' },
          processingStatus: 'pending',
        });
      } catch (err) {
        safeLog('error', {
          event: 'sendflow_webhook_insert_failed',
          workspace_id: workspaceId,
          sendflow_event_id: payload.id,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        return c.json({ error: 'internal_error' }, 500);
      }
    }

    // -----------------------------------------------------------------------
    // Step 9: Enqueue
    // -----------------------------------------------------------------------
    try {
      await c.env.QUEUE_EVENTS.send({
        platform: 'sendflow',
        workspace_id: workspaceId,
        event_id: payload.id,
        sendflow_event: payload.event,
        campaign_id: payload.data.campaignId,
        resolved_event_name: eventName,
      });
    } catch (err) {
      safeLog('error', {
        event: 'sendflow_webhook_enqueue_failed',
        workspace_id: workspaceId,
        sendflow_event_id: payload.id,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }

    safeLog('info', {
      event: 'sendflow_webhook_accepted',
      workspace_id: workspaceId,
      sendflow_event_id: payload.id,
      campaign_id: payload.data.campaignId,
      sendflow_event: payload.event,
      resolved_event_name: eventName,
    });

    return c.json({ received: true }, 202);
  });

  return router;
}

export const sendflowWebhookRoute = createSendflowWebhookRoute();
