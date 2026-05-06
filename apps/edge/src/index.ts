/**
 * apps/edge/src/index.ts — Cloudflare Worker entry point (Hono).
 *
 * Middleware chain (applied in order):
 *   sanitize-logs  → sets request_id, logs safe fields, ensures X-Request-Id on response
 *   auth-public-token (per route group) → sets workspace_id + page_id in context
 *   cors (per route group) → validates Origin against allowed_domains
 *   rate-limit (per route group) → sliding window via KV
 *   → handler
 *
 * Public routes (/v1/events, /v1/lead, /v1/config):
 *   Auth header: X-Funil-Site (page_token)
 *   Rate limit: route-specific limits
 *
 * Health route (/health): no auth, no rate limit.
 *
 * Queue consumer (gt-dispatch):
 *   Each message carries { dispatch_job_id, destination }.
 *   BR-DISPATCH-002: atomic lock (pending|retrying → processing) before calling external API.
 *   INV-DISPATCH-008: at-least-once queue — lock prevents duplicate external calls.
 *
 * BR-PRIVACY-001: sanitize-logs applied globally — zero PII in log output.
 * INV-PAGE-007: auth-public-token enforces workspace isolation per token.
 */

import type {
  ExecutionContext,
  MessageBatch,
  ScheduledEvent,
} from '@cloudflare/workers-types';
import type { Db } from '@globaltracker/db';
import {
  events,
  createDb,
  launches,
  leads,
  pages,
  pageTokens,
  workspaces,
} from '@globaltracker/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { runAudienceSync } from './crons/audience-sync.js';
import { ingestDailySpend } from './crons/cost-ingestor.js';
import {
  checkEligibility as checkGa4Eligibility,
  mapEventToGa4Payload,
  sendToGa4,
} from './dispatchers/ga4-mp/index.js';
import {
  checkEligibility as checkGoogleAdsEligibility,
  mapEventToConversionUpload,
  refreshAccessToken as refreshGoogleAdsToken,
  sendConversionUpload,
} from './dispatchers/google-ads-conversion/index.js';
import {
  type EnhancedConversionsLaunchConfig,
  checkEligibility as checkEnhancedEligibility,
  mapEventToEnhancedConversion,
  refreshAccessToken as refreshEnhancedToken,
  sendEnhancedConversion,
} from './dispatchers/google-enhanced-conversions/index.js';
import {
  checkEligibility,
  mapEventToMetaPayload,
  sendToMetaCapi,
} from './dispatchers/meta-capi/index.js';
import {
  type DispatchFn,
  type DispatchResult,
  processDispatchJob,
} from './lib/dispatch.js';
import { processGuruRawEvent } from './lib/guru-raw-events-processor.js';
import { processRawEvent } from './lib/raw-events-processor.js';
import {
  type LookupPageTokenFn,
  authPublicToken,
} from './middleware/auth-public-token.js';
import { type GetAllowedDomainsFn, corsMiddleware } from './middleware/cors.js';
import { rateLimit } from './middleware/rate-limit.js';
import { safeLog, sanitizeLogs } from './middleware/sanitize-logs.js';
import { adminLeadsEraseRoute } from './routes/admin/leads-erase.js';
import { createConfigRoute } from './routes/config.js';
import type { GetPageConfigFn } from './routes/config.js';
import { dispatchReplayRoute } from './routes/dispatch-replay.js';
import { eventsRoute } from './routes/events.js';
import { createFunnelTemplatesRoute } from './routes/funnel-templates.js';
import { healthCpRoute } from './routes/health-cp.js';
import { helpRoute } from './routes/help.js';
import { integrationsTestRoute } from './routes/integrations-test.js';
import { launchesRoute } from './routes/launches.js';
import { leadRoute } from './routes/lead.js';
import { leadsTimelineRoute } from './routes/leads-timeline.js';
import { onboardingStateRoute } from './routes/onboarding-state.js';
import { orchestratorRoute } from './routes/orchestrator.js';
import { createPagesStatusRoute } from './routes/pages-status.js';
import { pagesRoute } from './routes/pages.js';
import { redirectRoute } from './routes/redirect.js';
import { workspaceConfigRoute } from './routes/workspace-config.js';
import { createGuruWebhookRoute } from './routes/webhooks/guru.js';
import { createSendflowWebhookRoute } from './routes/webhooks/sendflow.js';

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

type Bindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  HYPERDRIVE: Hyperdrive;
  META_CAPI_TOKEN: string;
  META_CAPI_TEST_EVENT_CODE?: string;
  // T-13-015: AES-GCM master key (hex, 32 bytes) for PII encryption.
  // Set via `wrangler secret put PII_MASTER_KEY_V1`.
  PII_MASTER_KEY_V1?: string;
  // Dev shortcut: workspace_id fixo para local dev (substituído por auth-cp.ts em prod)
  DEV_WORKSPACE_ID?: string;
  // Cost ingestor credentials (T-4-001 / T-4-002)
  META_ADS_ACCOUNT_ID: string;
  META_ADS_ACCESS_TOKEN: string;
  GOOGLE_ADS_CUSTOMER_ID: string;
  GOOGLE_ADS_DEVELOPER_TOKEN: string;
  GOOGLE_ADS_CLIENT_ID: string;
  GOOGLE_ADS_CLIENT_SECRET: string;
  GOOGLE_ADS_REFRESH_TOKEN: string;
  GOOGLE_ADS_CURRENCY: string;
  FX_RATES_PROVIDER?: string;
  FX_RATES_API_KEY?: string;
  // GA4 Measurement Protocol (T-4-007)
  GA4_MEASUREMENT_ID: string;
  GA4_API_SECRET: string;
  DEBUG_GA4?: string;
  DATABASE_URL?: string;
};

// ---------------------------------------------------------------------------
// Queue message schema
// ---------------------------------------------------------------------------

/** Message published to gt-dispatch — carries job ID and destination for routing. */
type DispatchQueueMessage = {
  dispatch_job_id: string;
  destination: string;
};

/** Message published to gt-events — carries raw_event_id for ingestion processor. */
type EventsQueueMessage = {
  raw_event_id: string;
  workspace_id: string;
  /** Optional: platform that produced the raw_event. Used to route to the correct processor. */
  event_id?: string;
  event_type?: string;
  platform?: string;
};

type AnyQueueMessage = DispatchQueueMessage | EventsQueueMessage;

// ---------------------------------------------------------------------------
// Context variables
// ---------------------------------------------------------------------------

type Variables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Global middleware (all routes)
// BR-PRIVACY-001: sanitize-logs applied globally — ensures X-Request-Id + safe logs
// ---------------------------------------------------------------------------
app.use('*', sanitizeLogs());

// ---------------------------------------------------------------------------
// Health check — no auth, no rate limit
// ---------------------------------------------------------------------------
app.get('/health', (c) => {
  return c.json({ status: 'ok', environment: c.env.ENVIRONMENT });
});

// ---------------------------------------------------------------------------
// Public routes — /v1/* (tracker.js endpoints)
//
// NOTE: In Sprint 1 these stubs accept requests after middleware validation.
// Route handlers for /v1/events, /v1/lead, /v1/config will be added in
// subsequent T-IDs by domain-author and edge-author.
//
// Middleware order: auth → cors → rate-limit → handler
// ---------------------------------------------------------------------------

/**
 * Lookup function for page_tokens — queries DB by token_hash via Hyperdrive.
 * Falls back to DATABASE_URL in local dev (HYPERDRIVE.connectionString requires prod env).
 */
const lookupPageToken: LookupPageTokenFn = async (tokenHash, bindings) => {
  const env = bindings as Bindings;
  const connString = env.DATABASE_URL ?? env.HYPERDRIVE.connectionString;
  const db = createDb(connString);
  const rows = await db
    .select({
      workspaceId: pageTokens.workspaceId,
      pageId: pageTokens.pageId,
      launchId: pages.launchId,
      status: pageTokens.status,
    })
    .from(pageTokens)
    .innerJoin(pages, eq(pages.id, pageTokens.pageId))
    .where(eq(pageTokens.tokenHash, tokenHash))
    .limit(1);
  if (!rows[0]) return null;
  return {
    workspaceId: rows[0].workspaceId,
    pageId: rows[0].pageId,
    launchId: rows[0].launchId ?? null,
    status: rows[0].status as 'active' | 'rotating' | 'revoked',
  };
};

/**
 * Get allowed domains for a page — queried from DB by page_id.
 * domain-author implements: apps/edge/src/lib/page.ts → getPageById()
 */
const getAllowedDomains: GetAllowedDomainsFn = async (_pageId) => {
  // TODO(T-1-domain): wire up apps/edge/src/lib/page.ts → getPageById().allowedDomains
  return [];
};

/**
 * Lookup page config for /v1/config — queries pages.event_config via Hyperdrive.
 * Auth middleware has already validated workspace ownership via page token.
 */
const getPageConfig: GetPageConfigFn = async (_workspaceId, pageId, env) => {
  const e = env as Bindings;
  const connString = e.DATABASE_URL ?? e.HYPERDRIVE.connectionString;
  const db = createDb(connString);
  const rows = await db
    .select({
      status: pages.status,
      eventConfig: pages.eventConfig,
    })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  if (!rows[0]) return null;
  // Defensive parse: pages.event_config is JSONB, but legacy rows saved via the
  // CP UI were double-stringified ({"...":"..."} as a JSON-encoded string inside
  // the JSONB column). Accept both shapes so the Edge keeps working until the
  // CP save bug is fixed and rows are normalized.
  let ec: Record<string, unknown> = {};
  const raw = rows[0].eventConfig;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') ec = parsed as Record<string, unknown>;
    } catch {
      // unparseable → treat as empty config
    }
  } else if (raw && typeof raw === 'object') {
    ec = raw as Record<string, unknown>;
  }

  // Canonical schema is {canonical: string[], custom: string[]} (CP + migration 0034).
  // Tracker dispatches custom events with a `custom:` prefix (BR-EVENT-001), so the
  // allowed list concatenates canonical names verbatim with `custom:`-prefixed customs.
  // Legacy `allowed_event_names` field still honored if present (back-compat).
  const canonical = Array.isArray(ec.canonical) ? (ec.canonical as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const custom = Array.isArray(ec.custom) ? (ec.custom as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const legacy = Array.isArray(ec.allowed_event_names)
    ? (ec.allowed_event_names as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const allowedEventNames =
    canonical.length > 0 || custom.length > 0
      ? [...canonical, ...custom.map((c) => `custom:${c}`)]
      : legacy;

  return {
    status: rows[0].status as 'draft' | 'active' | 'paused' | 'archived',
    eventConfig: ec,
    allowedEventNames,
    customDataSchema:
      typeof ec.custom_data_schema === 'object' && ec.custom_data_schema !== null
        ? (ec.custom_data_schema as Record<string, unknown>)
        : {},
    autoPageView: ec.auto_page_view === true,
    metaPixelId: typeof ec.meta_pixel_id === 'string' ? ec.meta_pixel_id : null,
    ga4MeasurementId:
      typeof ec.ga4_measurement_id === 'string' ? ec.ga4_measurement_id : null,
    leadTokenTtlDays: typeof ec.lead_token_ttl_days === 'number' ? ec.lead_token_ttl_days : 60,
  };
};

// ---------------------------------------------------------------------------
// Public route middleware — applied before sub-router handlers via .use()
// Middleware order per path: auth → cors → rate-limit
// ---------------------------------------------------------------------------

// Control Plane allowed origins — shared between cpCors and /v1/events dispatch
const CP_ORIGINS = [
  'http://localhost:3000',
  'https://control.globaltracker.io',
];

// Control Plane CORS — must be defined before /v1/events dispatch middleware
const cpCors = corsMiddleware({
  mode: 'admin',
  adminAllowedOrigins: CP_ORIGINS,
});

// /v1/events serves two audiences on different methods:
//   GET     → CP query (Bearer auth in handler, admin CORS needed for Authorization header)
//   POST    → tracker.js ingest (X-Funil-Site auth, public CORS, rate-limit)
//   OPTIONS → preflight routed by origin (admin vs public CORS)
//
// corsMiddleware returns a Response directly for OPTIONS (not via next), so OPTIONS
// must be handled separately from POST to avoid discarding the Response in composition.
app.use('/v1/events', async (c, next) => {
  const method = c.req.method;
  const origin = c.req.header('Origin') ?? '';
  const isAdminOrigin = CP_ORIGINS.includes(origin);

  if (method === 'OPTIONS') {
    // Route preflight to the appropriate CORS handler — each returns 204 directly
    return isAdminOrigin
      ? cpCors(c, next)
      : corsMiddleware({ mode: 'public', getAllowedDomains })(c, next);
  }

  if (method === 'GET') {
    // CP query — admin CORS only; handler has its own Bearer auth
    return cpCors(c, next);
  }

  // POST from tracker.js — full public middleware chain
  return authPublicToken(lookupPageToken)(c, async () => {
    await corsMiddleware({ mode: 'public', getAllowedDomains })(c, async () => {
      await rateLimit({ routeGroup: 'events' })(c, next);
    });
  });
});

app.use(
  '/v1/lead',
  authPublicToken(lookupPageToken),
  corsMiddleware({ mode: 'public', getAllowedDomains }),
  rateLimit({ routeGroup: 'lead' }),
);
app.use(
  '/v1/config/*',
  authPublicToken(lookupPageToken),
  corsMiddleware({ mode: 'public', getAllowedDomains }),
  rateLimit({ routeGroup: 'config' }),
);

app.use('/v1/health/*', cpCors);
app.use('/v1/onboarding/*', cpCors);
app.use('/v1/launches/*', cpCors);
app.use('/v1/funnel-templates/*', cpCors);
app.use('/v1/pages/*', cpCors);
app.use('/v1/leads/*', cpCors);
app.use('/v1/integrations/*', cpCors);
app.use('/v1/dispatch-jobs/*', cpCors);
app.use('/v1/help/*', cpCors);
app.use('/v1/orchestrator/*', cpCors);
app.use('/v1/workspace/*', cpCors);

// OPTIONS preflight for public tracker routes (/v1/lead, /v1/config, etc.)
// /v1/events OPTIONS is handled by the method-dispatch middleware above.
app.options(
  '/v1/*',
  corsMiddleware({ mode: 'public', getAllowedDomains }),
  () => new Response(null, { status: 204 }),
);

// ---------------------------------------------------------------------------
// Route mounts — sub-routers registered by T-1-016..T-1-020
// ---------------------------------------------------------------------------

app.route('/v1/events', eventsRoute);
app.route('/v1/lead', leadRoute);
app.route('/v1/config', createConfigRoute(getPageConfig));
app.route('/r', redirectRoute);
app.route('/v1/admin/leads', adminLeadsEraseRoute);

// Guru webhook — server-to-server; no authPublicToken, no corsMiddleware
// Token auth is validated inside the handler (BR-WEBHOOK-001: constant-time comparison).
app.route(
  '/v1/webhook/guru',
  createGuruWebhookRoute((env) =>
    createDb(
      (env as unknown as Bindings).DATABASE_URL ??
        (env as unknown as Bindings).HYPERDRIVE?.connectionString ??
        '',
    ),
  ),
);

// SendFlow webhook (T-13-011) — server-to-server. Auth via `sendtok` header
// (constant-time compare against workspace_integrations.sendflow_sendtok).
app.route(
  '/v1/webhooks/sendflow',
  createSendflowWebhookRoute((env) =>
    createDb(
      (env as unknown as Bindings).DATABASE_URL ??
        (env as unknown as Bindings).HYPERDRIVE?.connectionString ??
        '',
    ),
  ),
);

// Control Plane endpoints (Sprint 6 — Wave 1: T-6-003, T-6-004, T-6-007)
// Auth: Bearer token placeholder — JWT validation via auth-cp.ts in next pass.
app.route('/v1/pages', pagesRoute);
app.route(
  '/v1/pages',
  createPagesStatusRoute({
    getDb: (env) =>
      createDb(env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? ''),
  }),
);
app.route('/v1/health', healthCpRoute);
app.route('/v1/integrations', integrationsTestRoute);

// Control Plane endpoints (Sprint 6 — Wave 2: T-6-005, T-6-008, T-6-009, T-6-010)
app.route('/v1/launches', launchesRoute);
app.route(
  '/v1/funnel-templates',
  createFunnelTemplatesRoute((c) =>
    createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString),
  ),
);
app.route('/v1/onboarding', onboardingStateRoute);
app.route('/v1/dispatch-jobs', dispatchReplayRoute);
app.route('/v1/help', helpRoute);
app.route('/v1/leads', leadsTimelineRoute);
app.route('/v1/orchestrator/workflows', orchestratorRoute);

// Workspace config endpoint (Sprint 11 — T-FUNIL-021)
// Auth: Bearer token; OPERATOR/ADMIN role required (TODO T-AUTH-CP: full JWT RBAC).
// BR-RBAC-002: workspace_id from auth context, never from body.
app.route('/v1/workspace', workspaceConfigRoute);

// ---------------------------------------------------------------------------
// Queue consumer — gt-dispatch
//
// BR-DISPATCH-002: atomic lock (pending|retrying → processing) prevents
//   duplicate calls to external APIs even when Queues deliver at-least-once.
// INV-DISPATCH-008: 0-row UPDATE means another consumer already claimed the
//   job — ack without calling the dispatcher.
// BR-PRIVACY-001: no PII in log output (safeLog used throughout).
// ---------------------------------------------------------------------------

async function queueHandler(
  batch: MessageBatch<AnyQueueMessage>,
  env: Bindings,
): Promise<void> {
  const db = createDb(env.DATABASE_URL ?? env.HYPERDRIVE.connectionString);

  for (const message of batch.messages) {
    const body = message.body;

    // Route by message shape: raw_event_id → gt-events ingestion path.
    if ('raw_event_id' in body) {
      const { raw_event_id, platform } = body as EventsQueueMessage;
      try {
        // Route to the correct processor based on the originating platform.
        // BR-EVENT-002: each processor enforces idempotency on (workspace_id, event_id).
        const result =
          platform === 'guru'
            ? await processGuruRawEvent(raw_event_id, db)
            : await processRawEvent(raw_event_id, db);

        if (!result.ok) {
          safeLog('warn', {
            event: 'ingestion_failed',
            raw_event_id,
            platform: platform ?? 'tracker',
            error_code: result.error.code,
          });
        } else {
          safeLog('info', {
            event: 'ingestion_processed',
            raw_event_id,
            platform: platform ?? 'tracker',
            dispatch_jobs_created: result.value.dispatch_jobs_created,
          });
          // Enqueue each created dispatch_job to gt-dispatch for external calls.
          for (const job of result.value.dispatch_job_ids) {
            try {
              await env.QUEUE_DISPATCH.send({
                dispatch_job_id: job.id,
                destination: job.destination,
              });
            } catch (qErr) {
              safeLog('error', {
                event: 'dispatch_enqueue_failed',
                raw_event_id,
                dispatch_job_id: job.id,
                error_type:
                  qErr instanceof Error ? qErr.constructor.name : 'unknown',
              });
            }
          }
        }
        message.ack();
      } catch (err) {
        safeLog('error', {
          event: 'ingestion_unhandled_error',
          raw_event_id,
          platform: platform ?? 'tracker',
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        message.retry();
      }
      continue;
    }

    // gt-dispatch path: dispatch_job_id + destination.
    const { dispatch_job_id, destination } = body as DispatchQueueMessage;

    try {
      let dispatchFn: DispatchFn;

      if (destination === 'meta_capi') {
        dispatchFn = buildMetaCapiDispatchFn(env, db);
      } else if (destination === 'ga4_mp') {
        dispatchFn = buildGa4DispatchFn(env, db);
      } else if (destination === 'google_ads_conversion') {
        dispatchFn = buildGoogleAdsConversionDispatchFn(env, db);
      } else if (destination === 'google_enhancement') {
        dispatchFn = buildEnhancedConversionDispatchFn(env, db);
      } else {
        safeLog('warn', {
          event: 'dispatch_unknown_destination',
          dispatch_job_id,
          destination,
        });
        message.ack();
        continue;
      }

      const result = await processDispatchJob(dispatch_job_id, dispatchFn, db);

      if (!result.ok && result.error.code === 'already_processing') {
        safeLog('info', {
          event: 'dispatch_already_processing',
          dispatch_job_id,
        });
      } else if (!result.ok) {
        safeLog('warn', {
          event: 'dispatch_processing_error',
          dispatch_job_id,
          error_code: result.error.code,
        });
      } else {
        safeLog('info', {
          event: 'dispatch_processed',
          dispatch_job_id,
          destination,
        });
      }

      message.ack();
    } catch (err) {
      safeLog('error', {
        event: 'dispatch_unhandled_error',
        dispatch_job_id,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
      message.retry();
    }
  }
}

// ---------------------------------------------------------------------------
// Meta CAPI dispatch function factory
// ---------------------------------------------------------------------------

/**
 * Builds the dispatchFn for a Meta CAPI job.
 *
 * The returned function:
 *   1. Loads the event from DB.
 *   2. Loads the associated lead (if any).
 *   3. Loads the launch config (for pixel_id).
 *   4. Calls checkEligibility — returns skip DispatchResult if not eligible.
 *   5. Maps to MetaCapiPayload via mapEventToMetaPayload.
 *   6. Calls sendToMetaCapi — returns MetaCapiResult mapped to DispatchResult.
 *
 * BR-DISPATCH-002: processDispatchJob already holds the atomic lock before calling this.
 * BR-DISPATCH-004: checkEligibility provides mandatory skip_reason on ineligible.
 * BR-PRIVACY-001: no PII logged.
 */
function buildMetaCapiDispatchFn(env: Bindings, db: Db): DispatchFn {
  return async (job): Promise<DispatchResult> => {
    // 1. Load the source event.
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, job.eventId));

    if (!event) {
      // Event not found — treat as permanent failure (data integrity issue).
      return { ok: false, kind: 'permanent_failure', code: 'event_not_found' };
    }

    // 2. Load lead (if associated).
    let lead: typeof leads.$inferSelect | undefined;
    if (job.leadId) {
      const rows = await db
        .select()
        .from(leads)
        .where(eq(leads.id, job.leadId));
      lead = rows[0];
    }

    // 3. Load launch config (for pixel_id).
    let launchConfig: {
      tracking?: { meta?: { pixel_id?: string | null } | null } | null;
    } | null = null;
    if (event.launchId) {
      const [launch] = await db
        .select({ config: launches.config })
        .from(launches)
        .where(eq(launches.id, event.launchId));
      // BR-DISPATCH-004: launchConfig drives pixel_id eligibility check.
      launchConfig = (launch?.config as typeof launchConfig) ?? null;
    }

    // 4. Check eligibility — pure function, no I/O.
    // BR-DISPATCH-004: checkEligibility returns mandatory skip_reason when not eligible.
    const eligibility = checkEligibility(
      {
        consent_snapshot: event.consentSnapshot as Parameters<
          typeof checkEligibility
        >[0]['consent_snapshot'],
        user_data: event.userData as Parameters<
          typeof checkEligibility
        >[0]['user_data'],
      },
      lead ? { email_hash: lead.emailHash, phone_hash: lead.phoneHash } : null,
      launchConfig,
    );

    if (!eligibility.eligible) {
      // BR-DISPATCH-004: skip_reason is mandatory when skipping.
      return { ok: false, kind: 'skip', reason: eligibility.reason };
    }

    // 5. Map internal event → MetaCapiPayload.
    // T-8-005: test_event_code only added when is_test=true; never leak env var to prod events.
    let resolvedTestEventCode: string | undefined;
    if (event.isTest) {
      resolvedTestEventCode = env.META_CAPI_TEST_EVENT_CODE;
      if (!resolvedTestEventCode) {
        safeLog('warn', {
          event: 'meta_capi_test_mode_no_code',
          dispatch_job_id: job.id,
        });
      }
    }

    const payload = mapEventToMetaPayload(
      {
        event_id: event.id,
        event_name: event.eventName,
        event_time: event.eventTime,
        lead_id: event.leadId,
        workspace_id: event.workspaceId,
        user_data: event.userData as Parameters<
          typeof mapEventToMetaPayload
        >[0]['user_data'],
        custom_data: event.customData as Parameters<
          typeof mapEventToMetaPayload
        >[0]['custom_data'],
      },
      lead
        ? {
            email_hash_external: lead.emailHashExternal,
            phone_hash_external: lead.phoneHashExternal,
            fn_hash: lead.fnHash,
            ln_hash: lead.lnHash,
          }
        : null,
      { testEventCode: resolvedTestEventCode },
    );

    // 6. Resolve capi_token: prefer workspaces.config (set by onboarding wizard), fallback to env var.
    let capiToken = env.META_CAPI_TOKEN;
    const [ws] = await db
      .select({ config: workspaces.config })
      .from(workspaces)
      .where(eq(workspaces.id, event.workspaceId));
    const wsCapiToken = (ws?.config as Record<string, unknown> | undefined)
      ?.integrations as Record<string, unknown> | undefined;
    const wsMetaToken = wsCapiToken?.meta as
      | Record<string, unknown>
      | undefined;
    if (wsMetaToken?.capi_token) capiToken = wsMetaToken.capi_token as string;

    // 7. Send to Meta CAPI — injectable fetch.
    const capiResult = await sendToMetaCapi(
      payload,
      {
        pixelId: job.destinationResourceId,
        accessToken: capiToken,
        testEventCode: resolvedTestEventCode,
      },
      fetch,
    );

    // Map MetaCapiResult → DispatchResult.
    if (capiResult.ok) {
      return { ok: true };
    }
    // Non-ok results have the same shape as DispatchResult — pass through directly.
    return capiResult;
  };
}

// ---------------------------------------------------------------------------
// GA4 MP dispatch function factory
// ---------------------------------------------------------------------------

/**
 * Builds the dispatchFn for a GA4 Measurement Protocol job.
 *
 * The returned function:
 *   1. Loads the event from DB.
 *   2. Loads the associated lead (if any).
 *   3. Checks eligibility (consent, client_id, measurementId).
 *   4. Maps to Ga4MpPayload via mapEventToGa4Payload.
 *   5. Returns skip with 'no_ga4_equivalent' if mapper returns null.
 *   6. Calls sendToGa4 — returns Ga4Result mapped to DispatchResult.
 *
 * BR-DISPATCH-002: processDispatchJob already holds the atomic lock before calling this.
 * BR-DISPATCH-004: checkEligibility provides mandatory skip_reason on ineligible.
 * BR-CONSENT-003: analytics consent enforced by checkGa4Eligibility.
 * BR-PRIVACY-001: no PII logged.
 */
function buildGa4DispatchFn(env: Bindings, db: Db): DispatchFn {
  return async (job): Promise<DispatchResult> => {
    // 1. Load the source event.
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, job.eventId));

    if (!event) {
      return { ok: false, kind: 'permanent_failure', code: 'event_not_found' };
    }

    // 2. Load lead (if associated).
    let lead: typeof leads.$inferSelect | undefined;
    if (job.leadId) {
      const rows = await db
        .select()
        .from(leads)
        .where(eq(leads.id, job.leadId));
      lead = rows[0];
    }

    // 3. Resolve GA4 credentials: prefer workspaces.config, fallback to env vars.
    // BR-CONSENT-003: analytics consent required for GA4 MP.
    // BR-DISPATCH-004: checkEligibility returns mandatory skip_reason when not eligible.
    const [wsGa4] = await db
      .select({ config: workspaces.config })
      .from(workspaces)
      .where(eq(workspaces.id, event.workspaceId));
    const wsIntegrations = (
      wsGa4?.config as Record<string, unknown> | undefined
    )?.integrations as Record<string, unknown> | undefined;
    const wsGa4Config = wsIntegrations?.ga4 as
      | Record<string, unknown>
      | undefined;
    const ga4Config = {
      measurementId:
        (wsGa4Config?.measurement_id as string | undefined) ||
        env.GA4_MEASUREMENT_ID ||
        null,
      apiSecret:
        (wsGa4Config?.api_secret as string | undefined) ||
        env.GA4_API_SECRET ||
        null,
    };

    const eligibility = checkGa4Eligibility(
      {
        consent_snapshot: event.consentSnapshot as Parameters<
          typeof checkGa4Eligibility
        >[0]['consent_snapshot'],
        user_data: event.userData as Parameters<
          typeof checkGa4Eligibility
        >[0]['user_data'],
      },
      ga4Config,
    );

    if (!eligibility.eligible) {
      // BR-DISPATCH-004: skip_reason is mandatory when skipping.
      return { ok: false, kind: 'skip', reason: eligibility.reason };
    }

    // 4. Map internal event → Ga4MpPayload.
    const payload = mapEventToGa4Payload(
      {
        event_id: event.id,
        event_name: event.eventName,
        event_time: event.eventTime,
        lead_id: event.leadId,
        workspace_id: event.workspaceId,
        user_data: event.userData as Parameters<
          typeof mapEventToGa4Payload
        >[0]['user_data'],
        custom_data: event.customData as Parameters<
          typeof mapEventToGa4Payload
        >[0]['custom_data'],
        consent_snapshot: event.consentSnapshot as Parameters<
          typeof mapEventToGa4Payload
        >[0]['consent_snapshot'],
      },
      lead
        ? {
            public_id: undefined,
            external_id_hash: lead.externalIdHash ?? null,
          }
        : null,
    );

    // 5. No GA4 equivalent for this event_name — skip gracefully.
    if (payload === null) {
      return { ok: false, kind: 'skip', reason: 'no_ga4_equivalent' };
    }

    // 6. Send to GA4 MP — injectable fetch.
    const ga4Result = await sendToGa4(
      payload,
      {
        measurementId: ga4Config.measurementId ?? env.GA4_MEASUREMENT_ID,
        apiSecret: ga4Config.apiSecret ?? env.GA4_API_SECRET,
        // T-8-005: use debug endpoint when is_test=true OR DEBUG_GA4 env var set
        debugMode: event.isTest || env.DEBUG_GA4 === 'true',
      },
      fetch,
    );

    if (ga4Result.ok) {
      return { ok: true };
    }
    return ga4Result;
  };
}

// ---------------------------------------------------------------------------
// Google Ads Conversion Upload dispatch function factory
// ---------------------------------------------------------------------------

/**
 * Builds the dispatchFn for a Google Ads Conversion Upload job.
 *
 * The returned function:
 *   1. Loads the event from DB.
 *   2. Loads the launch config (for conversion_actions + ads_customer_id).
 *   3. Checks eligibility (consent, click_id, conversion_action, customer_id).
 *   4. Maps to ConversionUploadPayload via mapEventToConversionUpload.
 *   5. Refreshes OAuth access token and calls sendConversionUpload.
 *
 * BR-DISPATCH-002: processDispatchJob already holds the atomic lock before calling this.
 * BR-DISPATCH-004: checkEligibility provides mandatory skip_reason on ineligible.
 * BR-CONSENT-003: ad_user_data consent enforced by checkGoogleAdsEligibility.
 * BR-PRIVACY-001: no PII logged.
 */
function buildGoogleAdsConversionDispatchFn(env: Bindings, db: Db): DispatchFn {
  return async (job): Promise<DispatchResult> => {
    // 1. Load the source event.
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, job.eventId));

    if (!event) {
      return { ok: false, kind: 'permanent_failure', code: 'event_not_found' };
    }

    // T-8-005: Google Ads Conversion Upload has no test/sandbox concept isolated from prod.
    // Skip entirely to avoid polluting real conversion data. BR-DISPATCH-004: skip_reason non-empty.
    if (event.isTest) {
      return { ok: false, kind: 'skip', reason: 'test_mode' };
    }

    // 2. Load launch config (for conversion_actions + ads_customer_id).
    let launchConfig: {
      tracking?: {
        google?: {
          ads_customer_id?: string | null;
          conversion_actions?: Record<string, string> | null;
        } | null;
      } | null;
    } | null = null;
    if (event.launchId) {
      const [launch] = await db
        .select({ config: launches.config })
        .from(launches)
        .where(eq(launches.id, event.launchId));
      // BR-DISPATCH-004: launchConfig drives eligibility checks.
      launchConfig = (launch?.config as typeof launchConfig) ?? null;
    }

    // 3. Check eligibility — pure function, no I/O.
    // BR-CONSENT-003: ad_user_data consent required for Google Ads Conversion Upload.
    // BR-DISPATCH-004: checkEligibility returns mandatory skip_reason when not eligible.
    const eligibility = checkGoogleAdsEligibility(
      {
        event_name: event.eventName,
        consent_snapshot: event.consentSnapshot as Parameters<
          typeof checkGoogleAdsEligibility
        >[0]['consent_snapshot'],
        attribution: event.attribution as Parameters<
          typeof checkGoogleAdsEligibility
        >[0]['attribution'],
      },
      launchConfig,
    );

    if (!eligibility.eligible) {
      // BR-DISPATCH-004: skip_reason is mandatory when skipping.
      return { ok: false, kind: 'skip', reason: eligibility.reason };
    }

    // 4. Map internal event → ConversionUploadPayload.
    const payload = mapEventToConversionUpload(
      {
        event_id: event.id,
        event_name: event.eventName,
        event_time: event.eventTime,
        workspace_id: event.workspaceId,
        attribution: event.attribution as Parameters<
          typeof mapEventToConversionUpload
        >[0]['attribution'],
        custom_data: event.customData as Parameters<
          typeof mapEventToConversionUpload
        >[0]['custom_data'],
      },
      launchConfig ?? {},
    );

    // 5. Refresh OAuth token and send — injectable fetch.
    const oauthConfig = {
      clientId: env.GOOGLE_ADS_CLIENT_ID,
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
    };

    const accessToken = await refreshGoogleAdsToken(oauthConfig, fetch);

    const gadsResult = await sendConversionUpload(
      payload,
      {
        oauth: oauthConfig,
        developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
        customerId: env.GOOGLE_ADS_CUSTOMER_ID,
      },
      fetch,
    );

    // accessToken is consumed inside sendConversionUpload via oauth.refreshAccessToken;
    // the explicit call above is a no-op here — we pass the refreshed token via config.
    void accessToken;

    if (gadsResult.ok) {
      return { ok: true };
    }
    return gadsResult;
  };
}

// ---------------------------------------------------------------------------
// Google Ads Enhanced Conversions dispatch function factory
// ---------------------------------------------------------------------------

/**
 * Builds the dispatchFn for a Google Ads Enhanced Conversions job.
 *
 * The returned function:
 *   1. Loads the event from DB.
 *   2. Loads the associated lead (if any).
 *   3. Loads the launch config (for conversion_actions + ads_customer_id).
 *   4. Checks eligibility (consent, order_id, user_data, conversion_action, 24h window).
 *   5. Maps to EnhancedConversionPayload via mapEventToEnhancedConversion.
 *   6. Refreshes OAuth token and calls sendEnhancedConversion.
 *
 * BR-DISPATCH-002: processDispatchJob already holds the atomic lock before calling this.
 * BR-DISPATCH-004: checkEligibility provides mandatory skip_reason on ineligible.
 * BR-CONSENT-003: ad_user_data consent enforced by checkEnhancedEligibility.
 * BR-PRIVACY-001: no PII logged.
 */
function buildEnhancedConversionDispatchFn(env: Bindings, db: Db): DispatchFn {
  return async (job): Promise<DispatchResult> => {
    // 1. Load the source event.
    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, job.eventId));

    if (!event) {
      return { ok: false, kind: 'permanent_failure', code: 'event_not_found' };
    }

    // T-8-005: Enhanced Conversions has no sandbox mode — skip test events entirely.
    // BR-DISPATCH-004: skip_reason non-empty.
    if (event.isTest) {
      return { ok: false, kind: 'skip', reason: 'test_mode' };
    }

    // 2. Load lead (if associated).
    let lead: typeof leads.$inferSelect | undefined;
    if (job.leadId) {
      const rows = await db
        .select()
        .from(leads)
        .where(eq(leads.id, job.leadId));
      lead = rows[0];
    }

    // 3. Load launch config (for conversion_actions + ads_customer_id).
    // Typed as EnhancedConversionsLaunchConfig so TypeScript's control-flow
    // narrowing (post-eligibility guard) does not collapse it to `never`.
    let launchConfig: EnhancedConversionsLaunchConfig | null = null;
    if (event.launchId) {
      const [launch] = await db
        .select({ config: launches.config })
        .from(launches)
        .where(eq(launches.id, event.launchId));
      // BR-DISPATCH-004: launchConfig drives eligibility checks.
      launchConfig =
        (launch?.config as EnhancedConversionsLaunchConfig) ?? null;
    }

    // 4. Check eligibility — pure function, no I/O.
    // BR-CONSENT-003: ad_user_data consent required for Enhanced Conversions.
    // BR-DISPATCH-004: checkEligibility returns mandatory skip_reason when not eligible.
    const eligibility = checkEnhancedEligibility(
      {
        event_name: event.eventName,
        event_time: event.eventTime,
        consent_snapshot: event.consentSnapshot as Parameters<
          typeof checkEnhancedEligibility
        >[0]['consent_snapshot'],
        custom_data: event.customData as Parameters<
          typeof checkEnhancedEligibility
        >[0]['custom_data'],
      },
      lead ? { email_hash: lead.emailHash, phone_hash: lead.phoneHash } : null,
      launchConfig,
    );

    if (!eligibility.eligible) {
      // BR-DISPATCH-004: skip_reason is mandatory when skipping.
      return { ok: false, kind: 'skip', reason: eligibility.reason };
    }

    // 5. Map internal event → EnhancedConversionPayload.
    const payload = mapEventToEnhancedConversion(
      {
        event_id: event.id,
        event_name: event.eventName,
        event_time: event.eventTime,
        lead_id: event.leadId,
        workspace_id: event.workspaceId,
        custom_data: event.customData as Parameters<
          typeof mapEventToEnhancedConversion
        >[0]['custom_data'],
        consent_snapshot: event.consentSnapshot as Parameters<
          typeof mapEventToEnhancedConversion
        >[0]['consent_snapshot'],
      },
      lead
        ? {
            email_hash_external: lead.emailHashExternal,
            phone_hash_external: lead.phoneHashExternal,
            fn_hash: lead.fnHash,
            ln_hash: lead.lnHash,
          }
        : null,
      launchConfig ?? { tracking: null },
    );

    // 6. Refresh OAuth token and send — injectable fetch.
    const oauthConfig = {
      clientId: env.GOOGLE_ADS_CLIENT_ID,
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
    };

    const accessToken = await refreshEnhancedToken(oauthConfig, fetch);

    const customerId =
      launchConfig?.tracking?.google?.ads_customer_id ??
      env.GOOGLE_ADS_CUSTOMER_ID;

    const enhancedResult = await sendEnhancedConversion(
      payload,
      {
        customerId,
        developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
        accessToken,
      },
      fetch,
    );

    if (enhancedResult.ok) {
      return { ok: true };
    }
    return enhancedResult;
  };
}

// ---------------------------------------------------------------------------
// Scheduled handler — CF Cron Trigger (17:30 UTC daily)
//
// INV-COST-006: ingestDailySpend is idempotent — re-running on same date
//   yields the same DB state.
// BR-PRIVACY-001: no PII in log output (safeLog used).
// ---------------------------------------------------------------------------

async function scheduledHandler(
  event: ScheduledEvent,
  env: Bindings,
  _ctx: ExecutionContext,
): Promise<void> {
  const db = createDb(env.DATABASE_URL ?? env.HYPERDRIVE.connectionString);
  const cron = event.cron;

  // ---------------------------------------------------------------------------
  // 17:30 UTC — cost ingestor (INV-COST-006: idempotent upsert)
  // ---------------------------------------------------------------------------
  if (cron === '30 17 * * *') {
    const date = new Date(event.scheduledTime)
      .toISOString()
      .split('T')[0] as string;

    // INV-COST-006: idempotent — upsert ON CONFLICT DO UPDATE
    const result = await ingestDailySpend(date, env, db);

    // BR-PRIVACY-001: no PII — only counts and error strings logged
    safeLog('info', {
      event: 'cost_ingestor_completed',
      ingested: result.ingested,
      error_count: result.errors.length,
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // 01:00 UTC — audience sync (T-5-002)
  // Generates snapshots + diff-based sync jobs for all active audiences.
  // Does NOT call external APIs — dispatchers handle that (T-5-005/T-5-006).
  // BR-AUDIENCE-001: disabled_not_eligible audiences skip sync job creation.
  // BR-PRIVACY-001: safeLog used throughout inside runAudienceSync.
  // ---------------------------------------------------------------------------
  if (cron === '0 1 * * *') {
    await runAudienceSync({}, db);
    return;
  }

  // Unknown cron expression — log and return without throwing
  safeLog('warn', {
    event: 'scheduled_unknown_cron',
    cron,
  });
}

// ---------------------------------------------------------------------------
// Worker export — fetch handler + queue consumer + scheduled handler
// ---------------------------------------------------------------------------

export default {
  fetch: app.fetch,
  queue: queueHandler,
  scheduled: scheduledHandler,
};
