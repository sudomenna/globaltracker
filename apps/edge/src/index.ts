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
  auditLog,
  dispatchJobs,
  events,
  createDb,
  launches,
  leads,
  pages,
  pageTokens,
  rawEvents,
  workspaces,
} from '@globaltracker/db';
import { and, desc, eq, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { runAudienceSync } from './crons/audience-sync.js';
import { ingestDailySpend } from './crons/cost-ingestor.js';
import {
  checkEligibility as checkGa4Eligibility,
  mapEventToGa4Payload,
  sendToGa4,
} from './dispatchers/ga4-mp/index.js';
import {
  type ClientIdUserData,
  resolveClientIdExtended,
} from './dispatchers/ga4-mp/client-id-resolver.js';
import {
  checkEligibility as checkGoogleAdsEligibility,
  mapEventToConversionUpload,
  sendConversionUpload,
} from './dispatchers/google-ads-conversion/index.js';
import {
  type EnhancedConversionsLaunchConfig,
  checkEligibility as checkEnhancedEligibility,
  mapEventToEnhancedConversion,
  sendEnhancedConversion,
} from './dispatchers/google-enhanced-conversions/index.js';
import { getGoogleAdsAccessToken } from './lib/google-ads-oauth.js';
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
import { jsonb } from './lib/jsonb-cast.js';
import { processOnprofitRawEvent } from './lib/onprofit-raw-events-processor.js';
import { aggregatePurchaseValueByGroup } from './lib/transaction-aggregator.js';
import { processSendflowRawEvent } from './lib/sendflow-raw-events-processor.js';
import { hashPiiExternal } from './lib/pii.js';
import { processRawEvent } from './lib/raw-events-processor.js';
import {
  type LookupPageTokenFn,
  authPublicToken,
} from './middleware/auth-public-token.js';
import { type GetAllowedDomainsFn, corsMiddleware } from './middleware/cors.js';
import { rateLimit } from './middleware/rate-limit.js';
import { safeLog, sanitizeLogs } from './middleware/sanitize-logs.js';
import { adminLeadsEraseRoute } from './routes/admin/leads-erase.js';
import { createCostBackfillRoute } from './routes/admin/cost-backfill.js';
import { createConfigRoute } from './routes/config.js';
import type { GetPageConfigFn } from './routes/config.js';
import {
  createDispatchReplayRoute,
  type DispatchJobForReplay,
} from './routes/dispatch-replay.js';
import { eventsRoute } from './routes/events.js';
import { createFunnelTemplatesRoute } from './routes/funnel-templates.js';
import { healthCpRoute } from './routes/health-cp.js';
import { helpRoute } from './routes/help.js';
import { integrationsGoogleRoute } from './routes/integrations-google.js';
import { integrationsSendflowRoute } from './routes/integrations-sendflow.js';
import { integrationsTestRoute } from './routes/integrations-test.js';
import { launchesRoute } from './routes/launches.js';
import { leadRoute } from './routes/lead.js';
import { createLeadsPurchasesRoute } from './routes/leads-purchases.js';
import { createLeadsSummaryRoute } from './routes/leads-summary.js';
import { createLeadsTimelineRoute } from './routes/leads-timeline.js';
import { onboardingStateRoute } from './routes/onboarding-state.js';
import { orchestratorRoute } from './routes/orchestrator.js';
import { createPagesStatusRoute } from './routes/pages-status.js';
import { pagesRoute } from './routes/pages.js';
import { createProductsRoute } from './routes/products.js';
import { createLaunchProductsRoute } from './routes/launch-products.js';
import { createLaunchLeadsRoute } from './routes/launches-leads.js';
import { createMetaAudiencesRoute } from './routes/meta-audiences.js';
import { createDashboardStatsRoute } from './routes/dashboard-stats.js';
import { createRecoveryRoute } from './routes/recovery.js';
import { redirectRoute } from './routes/redirect.js';
import { workspaceConfigRoute } from './routes/workspace-config.js';
import { createGuruWebhookRoute } from './routes/webhooks/guru.js';
import { createOnprofitWebhookRoute } from './routes/webhooks/onprofit.js';
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
  // T-14-005/006/009: Google OAuth client credentials shared across workspaces.
  // Preferred over the legacy GOOGLE_ADS_CLIENT_ID/SECRET (which the cost
  // ingestor still consumes). When unset, the dispatchers fall back to
  // GOOGLE_ADS_CLIENT_ID/SECRET for backward compat.
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  FX_RATES_PROVIDER?: string;
  FX_RATES_API_KEY?: string;
  // GA4 Measurement Protocol (T-4-007)
  GA4_MEASUREMENT_ID: string;
  GA4_API_SECRET: string;
  DEBUG_GA4?: string;
  DATABASE_URL?: string;
  // Supabase project URL — used by JWKS verification in auth middleware (ADR-034)
  SUPABASE_URL?: string;
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
app.use('/v1/dashboard/*', cpCors);
app.use('/v1/onboarding/*', cpCors);
app.use('/v1/launches/*', cpCors);
app.use('/v1/funnel-templates/*', cpCors);
app.use('/v1/pages/*', cpCors);
app.use('/v1/leads/*', cpCors);
app.use('/v1/products/*', cpCors);
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
app.route('/v1/admin/cost-backfill', createCostBackfillRoute({
  buildDb: (env) => createDb(env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? ''),
}));

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

// OnProfit webhook — server-to-server; mounted under /v1/webhooks/* (plural,
// aligned with SendFlow). Workspace resolved by `?workspace=<slug>` query
// param. HMAC validation TODO until OnProfit publishes the signature spec
// (see TODO comment in routes/webhooks/onprofit.ts).
app.route(
  '/v1/webhooks/onprofit',
  createOnprofitWebhookRoute((env) =>
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
// SendFlow credentials endpoint (Sprint 13 — T-13-016b).
// Mount BEFORE the catch-all integrations test route so GET/PATCH
// `/sendflow/credentials` is not intercepted. The test route only handles
// POST `/:provider/test`, so there's no conflict — but mounting first is
// defensive ordering. BR-PRIVACY-001: never echoes raw sendtok.
app.route('/v1/integrations/google', integrationsGoogleRoute);
app.route('/v1/integrations/sendflow', integrationsSendflowRoute);
app.route('/v1/integrations', integrationsTestRoute);

// Control Plane endpoints (Sprint 6 — Wave 2: T-6-005, T-6-008, T-6-009, T-6-010)
// Sub-router: /v1/launches/:launch_public_id/products (T-PRODUCTS-008)
// IMPORTANT: must be mounted BEFORE launchesRoute, otherwise launchesRoute's
// catch-all auth middleware ('*') intercepts the path first.
app.route(
  '/v1/launches/:launch_public_id/products',
  createLaunchProductsRoute({
    getConnStr: (env) =>
      env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '',
  }),
);
// Recovery route (T-RECOVERY-004): /v1/launches/:public_id/recovery
// IMPORTANT: must be mounted BEFORE launchesRoute for the same reason as launch-products.
// BR-PRIVACY-001: PII decrypted on-demand; never logged.
// BR-RBAC-001: workspace_id from JWT membership, never from request body.
app.route(
  '/v1/launches',
  createRecoveryRoute({
    getConnStr: (env) =>
      env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '',
    getMasterKey: (env) => env.PII_MASTER_KEY_V1 ?? '',
  }),
);
// Leads tab route (T-LEADS-VIEW-002): /v1/launches/:public_id/leads
// IMPORTANT: must be mounted BEFORE launchesRoute for the same reason as launch-products.
// BR-PRIVACY-001: PII decrypted on-demand; never logged.
// BR-RBAC-001: workspace_id from JWT membership, never from request body.
// BR-IDENTITY-006 / ADR-034: PII masked for operator/viewer.
app.route(
  '/v1/launches',
  createLaunchLeadsRoute({
    getConnStr: (env) =>
      env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '',
    getMasterKey: (env) => env.PII_MASTER_KEY_V1 ?? '',
  }),
);
// Meta Audiences Mirror: POST /:public_id/meta-audiences/sync + GET /:public_id/meta-audiences
// IMPORTANT: mounted BEFORE launchesRoute to prevent catch-all interception.
// BR-RBAC-001: workspace_id from JWT membership. BR-RBAC-002: sync requires OPERATOR+.
// BR-PRIVACY-001: no PII in logs or error responses.
// INV-META-AUDIENCE-001: upsert is idempotent on (workspace_id, launch_id, meta_audience_id).
app.route(
  '/v1/launches',
  createMetaAudiencesRoute({
    getConnStr: (env) =>
      env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '',
  }),
);
app.route('/v1/launches', launchesRoute);
app.route(
  '/v1/funnel-templates',
  createFunnelTemplatesRoute((c) =>
    createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString),
  ),
);
app.route('/v1/onboarding', onboardingStateRoute);
app.route(
  '/v1/dashboard',
  createDashboardStatsRoute({
    getConnStr: (env) =>
      env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '',
  }),
);

// ---------------------------------------------------------------------------
// Dispatch-replay route — wired with real DB-backed deps.
// T-16-003: fixes ADR-025 standalone-mode bug where the previous mount used
//   `dispatchReplayRoute` (zero deps) and silently returned 202 without
//   persisting the child job nor the audit entry.
// BR-RBAC-002: getDispatchJob scoped by workspace_id (multi-tenant anchor).
// ADR-025: createReplayJob inserts a NEW dispatch_job child linked to the
//   original via `replayedFromDispatchJobId` — never resets the original.
// BR-AUDIT-001: insertAuditEntry persists action='replay_dispatch'.
// BR-PRIVACY-001: payload jsonb does not contain PII in clear (route enforces).
// ---------------------------------------------------------------------------
function buildDispatchReplayRoute(db: Db) {
  const getDispatchJob = async (
    jobId: string,
    workspaceId: string,
  ): Promise<DispatchJobForReplay | null> => {
    // BR-RBAC-002: filter by workspace_id to prevent cross-workspace lookup.
    const [row] = await db
      .select({
        id: dispatchJobs.id,
        workspace_id: dispatchJobs.workspaceId,
        lead_id: dispatchJobs.leadId,
        event_id: dispatchJobs.eventId,
        event_workspace_id: dispatchJobs.eventWorkspaceId,
        destination: dispatchJobs.destination,
        destination_account_id: dispatchJobs.destinationAccountId,
        destination_resource_id: dispatchJobs.destinationResourceId,
        destination_subresource: dispatchJobs.destinationSubresource,
        max_attempts: dispatchJobs.maxAttempts,
        payload: dispatchJobs.payload,
        status: dispatchJobs.status,
      })
      .from(dispatchJobs)
      .where(
        and(
          eq(dispatchJobs.id, jobId),
          eq(dispatchJobs.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!row) return null;

    return {
      ...row,
      payload: (row.payload as Record<string, unknown> | null) ?? {},
    };
  };

  const createReplayJob = async (params: {
    workspace_id: string;
    lead_id: string | null;
    event_id: string;
    event_workspace_id: string;
    destination: string;
    destination_account_id: string;
    destination_resource_id: string;
    destination_subresource: string | null;
    payload: Record<string, unknown>;
    max_attempts: number;
    idempotency_key: string;
    replayed_from_dispatch_job_id: string;
  }): Promise<{ id: string; destination: string }> => {
    // ADR-025: insert NEW dispatch_job linked to the original via
    //   replayedFromDispatchJobId. Status starts at 'pending' so the queue
    //   consumer (gt-dispatch) can claim it via the atomic lock
    //   (BR-DISPATCH-002 / INV-DISPATCH-008).
    const [row] = await db
      .insert(dispatchJobs)
      .values({
        workspaceId: params.workspace_id,
        leadId: params.lead_id,
        eventId: params.event_id,
        eventWorkspaceId: params.event_workspace_id,
        destination: params.destination,
        destinationAccountId: params.destination_account_id,
        destinationResourceId: params.destination_resource_id,
        destinationSubresource: params.destination_subresource,
        payload: jsonb(params.payload),
        maxAttempts: params.max_attempts,
        idempotencyKey: params.idempotency_key,
        replayedFromDispatchJobId: params.replayed_from_dispatch_job_id,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: new Date(),
      })
      .returning({
        id: dispatchJobs.id,
        destination: dispatchJobs.destination,
      });

    if (!row) {
      throw new Error('createReplayJob: insert returned no row');
    }

    return row;
  };

  const insertAuditEntry = async (entry: {
    workspace_id: string;
    actor_id: string;
    actor_type: string;
    action: string;
    entity_type: string;
    entity_id: string;
    metadata: Record<string, unknown>;
    request_id: string;
  }): Promise<void> => {
    // BR-AUDIT-001: append-only audit entry. The route's `metadata` payload
    //   maps onto the canonical `after` snapshot column (no PII — only opaque
    //   IDs + justification text). request_id goes into request_context per
    //   INV-AUDIT-003 (sanitized: request_id only, no IP/UA in this path).
    await db.insert(auditLog).values({
      workspaceId: entry.workspace_id,
      actorId: entry.actor_id,
      actorType: entry.actor_type,
      action: entry.action,
      entityType: entry.entity_type,
      entityId: entry.entity_id,
      after: jsonb(entry.metadata),
      requestContext: jsonb({ request_id: entry.request_id }),
    });
  };

  return createDispatchReplayRoute({
    getDispatchJob,
    createReplayJob,
    insertAuditEntry,
  });
}

// Per-request mount: build a fresh sub-router for each request so the route's
// dep closures own their own DB handle. Hyperdrive/postgres connection is
// re-created per-request anyway in CF Workers; this keeps wiring simple
// without forcing a `getDb` parameter into the route factory.
app.all('/v1/dispatch-jobs/:id/replay', async (c) => {
  const db = createDb(
    c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString,
  );
  const innerRoute = buildDispatchReplayRoute(db);
  const wrapper = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  wrapper.route('/v1/dispatch-jobs', innerRoute);
  return wrapper.fetch(c.req.raw, c.env, c.executionCtx);
});

app.route('/v1/help', helpRoute);
// Leads purchases route — mounted BEFORE summary and timeline so the more
// specific /:public_id/purchases path is matched first.
app.route(
  '/v1/leads',
  createLeadsPurchasesRoute({
    getConnStr: (env) => env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '',
  }),
);
// Leads summary route (T-17-007) — mounted BEFORE leads-timeline so the more
// specific /:public_id/summary path is matched ahead of any catch-all in the
// timeline router. Both share the /v1/leads prefix and identical auth chain.
app.route(
  '/v1/leads',
  createLeadsSummaryRoute({
    getConnStr: (env) => env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '',
  }),
);
app.route(
  '/v1/leads',
  createLeadsTimelineRoute({
    getConnStr: (env) => env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '',
    getMasterKey: (env) => env.PII_MASTER_KEY_V1 ?? '',
  }),
);
app.route('/v1/orchestrator/workflows', orchestratorRoute);

// Workspace config endpoint (Sprint 11 — T-FUNIL-021)
// Auth: Bearer token; OPERATOR/ADMIN role required (TODO T-AUTH-CP: full JWT RBAC).
// BR-RBAC-002: workspace_id from auth context, never from body.
app.route('/v1/workspace', workspaceConfigRoute);

// Products catalog (T-PRODUCTS-005). GET ≥ viewer, PATCH ≥ admin/owner.
// BR-PRODUCT-001/002/003: lifecycle backfill on category change.
app.route(
  '/v1/products',
  createProductsRoute({
    getConnStr: (env) => env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '',
  }),
);

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

  // gt-events-dlq: messages that exhausted max_retries on gt-events.
  // Mark the raw_event as 'failed' with the retry count so it surfaces in
  // observability and stops being re-queued by the outbox poller cron.
  if (batch.queue === 'gt-events-dlq') {
    for (const message of batch.messages) {
      const body = message.body as EventsQueueMessage;
      const rawEventId = body.raw_event_id;
      try {
        if (rawEventId) {
          await db
            .update(rawEvents)
            .set({
              processingStatus: 'failed',
              processedAt: new Date(),
              processingError: `dlq: max_retries exhausted on gt-events (attempts=${message.attempts ?? 'unknown'})`,
            })
            .where(eq(rawEvents.id, rawEventId));
        }
        safeLog('error', {
          event: 'dlq_event_marked_failed',
          raw_event_id: rawEventId,
          attempts: message.attempts,
        });
        message.ack();
      } catch (err) {
        safeLog('error', {
          event: 'dlq_handler_error',
          raw_event_id: rawEventId,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        message.ack();
      }
    }
    return;
  }

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
            ? await processGuruRawEvent(raw_event_id, db, env.PII_MASTER_KEY_V1)
            : platform === 'onprofit'
              ? await processOnprofitRawEvent(
                  raw_event_id,
                  db,
                  env.PII_MASTER_KEY_V1,
                )
              : platform === 'sendflow'
                ? await processSendflowRawEvent(raw_event_id, db)
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
              // ONPROFIT-W4: produto principal vem com delay_seconds=80 — dá
              // tempo para webhooks de order bumps chegarem e ficarem
              // disponíveis para agregação no dispatcher Meta CAPI.
              // BR-DISPATCH-007.
              const delaySeconds = (job as { delay_seconds?: number })
                .delay_seconds;
              await env.QUEUE_DISPATCH.send(
                {
                  dispatch_job_id: job.id,
                  destination: job.destination,
                },
                delaySeconds !== undefined ? { delaySeconds } : undefined,
              );
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
// Browser-signal enrichment from lead history
// ---------------------------------------------------------------------------

/**
 * Looks up the most recent fbc/fbp captured by ANY past event of the given lead.
 *
 * Why: webhook-sourced events (Guru Purchase, SendFlow Contact, etc) carry no
 * browser context — `events.user_data` is `{}`. The fbc/fbp signals were
 * captured by tracker.js on a prior PageView/Lead/click event. Without this
 * fallback, Meta CAPI Purchase events miss `fbc` and the Meta Diagnóstico
 * dashboard reports "Enviar Identificação do clique da Meta" — Meta estimates
 * +100% in additional reported conversions when fbc is present.
 *
 * Strategy: scan the lead's events DESC by received_at, take the freshest
 * non-null fbc and freshest non-null fbp (independently — they may come from
 * different events). LIMIT 10 caps the work for chatty leads; the canonical
 * source (PageView with utm_source=meta) is almost always within the most
 * recent few events.
 *
 * Performance: 1 query per dispatch. Indexed on (workspace_id, lead_id).
 * Skipped entirely when both signals are already present in the current event.
 */
async function lookupHistoricalBrowserSignals(
  db: Db,
  workspaceId: string,
  leadId: string,
): Promise<{
  fbc: string | null;
  fbp: string | null;
  ip: string | null;
  ua: string | null;
  visitor_id: string | null;
  geo_city: string | null;
  geo_region_code: string | null;
  geo_postal_code: string | null;
  geo_country: string | null;
}> {
  // Webhook Purchases (Guru/OnProfit/Hotmart/etc) não carregam fbc/fbp/IP/UA/geo
  // no payload. Buscamos esses sinais nos events anteriores do mesmo lead
  // (PageView/Lead/click_*) capturados pelo tracker.js. Isso eleva muito o
  // EMQ do Meta CAPI: sem esses sinais, advanced match cai pra 5/10.
  //
  // GEO-CITY-ENRICHMENT-GAP (2026-05-09): geo_city/region/postal/country
  // adicionados ao lookup. Antes, Purchase Guru sem contact.address ficava
  // travado em match_score=7/8 — agora atinge 8/8 quando o lead já passou
  // pela LP (tracker captura geo via Cloudflare CF-IPCity headers). Replicar
  // ip/ua: se evento corrente trouxer próprio geo, dispatcher prefere; senão
  // usa o histórico do mesmo lead.
  //
  // T-13-013: rows pré-deploy ed9a490d têm user_data armazenado como
  // jsonb-string (jsonb_typeof='string') por causa do bug do driver Hyperdrive.
  // O filtro `user_data->>'fbc'` direto NÃO matcha nessas rows porque o operador
  // ->> sobre uma jsonb-string retorna NULL. Usar `(user_data #>> '{}')::jsonb`
  // re-parseia a string como objeto antes do ->>. Funciona para rows novas
  // (jsonb-object) e legadas (jsonb-string) — idempotente.
  const rows = await db
    .select({
      userData: events.userData,
      visitorId: events.visitorId,
    })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, workspaceId),
        eq(events.leadId, leadId),
        sql`(
          ${events.visitorId} IS NOT NULL OR
          (${events.userData} #>> '{}')::jsonb->>'fbc' IS NOT NULL OR
          (${events.userData} #>> '{}')::jsonb->>'fbp' IS NOT NULL OR
          (${events.userData} #>> '{}')::jsonb->>'client_ip_address' IS NOT NULL OR
          (${events.userData} #>> '{}')::jsonb->>'client_user_agent' IS NOT NULL OR
          (${events.userData} #>> '{}')::jsonb->>'geo_city' IS NOT NULL OR
          (${events.userData} #>> '{}')::jsonb->>'geo_country' IS NOT NULL
        )`,
      ),
    )
    .orderBy(desc(events.receivedAt))
    .limit(10);

  let fbc: string | null = null;
  let fbp: string | null = null;
  let ip: string | null = null;
  let ua: string | null = null;
  let visitor_id: string | null = null;
  let geo_city: string | null = null;
  let geo_region_code: string | null = null;
  let geo_postal_code: string | null = null;
  let geo_country: string | null = null;
  for (const row of rows) {
    if (
      !visitor_id &&
      typeof row.visitorId === 'string' &&
      row.visitorId.length > 0
    ) {
      visitor_id = row.visitorId;
    }
    // T-13-013: row.userData pode chegar como string (rows pré-deploy) ou
    // object (rows pós-jsonb-fix). Parse defensivo aceita os dois.
    let ud: Record<string, unknown>;
    if (typeof row.userData === 'string') {
      try {
        ud = JSON.parse(row.userData) as Record<string, unknown>;
      } catch {
        continue;
      }
    } else {
      ud = (row.userData ?? {}) as Record<string, unknown>;
    }
    if (!fbc && typeof ud.fbc === 'string' && ud.fbc.length > 0) fbc = ud.fbc;
    if (!fbp && typeof ud.fbp === 'string' && ud.fbp.length > 0) fbp = ud.fbp;
    if (
      !ip &&
      typeof ud.client_ip_address === 'string' &&
      ud.client_ip_address.length > 0
    ) {
      ip = ud.client_ip_address;
    }
    if (
      !ua &&
      typeof ud.client_user_agent === 'string' &&
      ud.client_user_agent.length > 0
    ) {
      ua = ud.client_user_agent;
    }
    if (
      !geo_city &&
      typeof ud.geo_city === 'string' &&
      ud.geo_city.length > 0
    ) {
      geo_city = ud.geo_city;
    }
    if (
      !geo_region_code &&
      typeof ud.geo_region_code === 'string' &&
      ud.geo_region_code.length > 0
    ) {
      geo_region_code = ud.geo_region_code;
    }
    if (
      !geo_postal_code &&
      typeof ud.geo_postal_code === 'string' &&
      ud.geo_postal_code.length > 0
    ) {
      geo_postal_code = ud.geo_postal_code;
    }
    if (
      !geo_country &&
      typeof ud.geo_country === 'string' &&
      ud.geo_country.length > 0
    ) {
      geo_country = ud.geo_country;
    }
    if (
      fbc &&
      fbp &&
      ip &&
      ua &&
      visitor_id &&
      geo_city &&
      geo_region_code &&
      geo_postal_code &&
      geo_country
    )
      break;
  }
  return {
    fbc,
    fbp,
    ip,
    ua,
    visitor_id,
    geo_city,
    geo_region_code,
    geo_postal_code,
    geo_country,
  };
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

    // 3b. Resolve event_source_url for Meta CAPI.
    // Priority: event.pageId (exact page) → first sales page with URL (launch fallback).
    // Query params are stripped — Meta expects a clean URL.
    //
    // DEBT: when a launch has multiple sales pages (e.g. main offer + downsell),
    // webhook events (Purchase) land here with pageId=null and always get the
    // first sales page URL. Fix: propagate page_id through the webhook processor
    // using the offer's associated page, or store a default page per launch role.
    let eventSourceUrl: string | null = null;
    {
      let rawUrl: string | null = null;

      if (event.pageId) {
        const [pg] = await db
          .select({ url: pages.url })
          .from(pages)
          .where(and(eq(pages.id, event.pageId), isNotNull(pages.url)))
          .limit(1);
        rawUrl = pg?.url ?? null;
      }

      if (!rawUrl && event.launchId) {
        const [pg] = await db
          .select({ url: pages.url })
          .from(pages)
          .where(
            and(
              eq(pages.launchId, event.launchId),
              eq(pages.role, 'sales'),
              isNotNull(pages.url),
            ),
          )
          .limit(1);
        rawUrl = pg?.url ?? null;
      }

      if (rawUrl) {
        try {
          const u = new URL(rawUrl);
          eventSourceUrl = `${u.origin}${u.pathname}`;
        } catch {
          // malformed URL stored in pages.url — skip
        }
      }
    }

    // T-13-013: rows pré-deploy ed9a490d têm event.userData / event.consentSnapshot
    // como string (jsonb-string bug). Parse defensivo aceita string OU object.
    const parseUd = (raw: unknown): Record<string, unknown> => {
      if (raw == null) return {};
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return {};
        }
      }
      if (typeof raw === 'object') return raw as Record<string, unknown>;
      return {};
    };
    const parsedConsent = parseUd(event.consentSnapshot);
    const parsedUserData = parseUd(event.userData);
    const parsedCustomData = parseUd(event.customData);

    // === ONPROFIT-W4: agregação de valor para transações multi-produto ===
    // Quando o event é Purchase E tem transaction_group_id E item_type='product'
    // (ou null para events legacy/Guru), soma custom_data.amount de TODOS os
    // events do grupo (produto principal + N order bumps) para que o Meta CAPI
    // receba o valor real da transação consolidada. Evita fragmentar ROAS no
    // algoritmo de bidding.
    //
    // BR-DISPATCH-007: agregação por transaction_group_id consolida Purchase.
    // BR-EVENT-002: idempotency_key não muda (ainda 1 dispatch_job por event
    //   principal, derivado de event.eventId).
    // BR-PRIVACY-001: log apenas IDs internos + contadores.
    //
    // Ver: memory/project_dispatch_consolidation_pattern.md
    {
      const tgid =
        typeof parsedCustomData.transaction_group_id === 'string'
          ? parsedCustomData.transaction_group_id
          : null;
      const itemType =
        typeof parsedCustomData.item_type === 'string'
          ? parsedCustomData.item_type
          : null;
      const currentAmount =
        typeof parsedCustomData.amount === 'number'
          ? parsedCustomData.amount
          : 0;

      if (
        (event.eventName === 'Purchase' || event.eventName === 'InitiateCheckout') &&
        tgid &&
        (itemType === 'product' || itemType === null)
      ) {
        const agg = await aggregatePurchaseValueByGroup({
          db,
          workspaceId: event.workspaceId,
          transactionGroupId: tgid,
          eventName: event.eventName,
          currentEventAmount: currentAmount,
        });

        if (agg.isAggregated) {
          // Mutate local copy — não persiste no DB. Mapper lerá `parsedCustomData`
          // logo abaixo na chamada de mapEventToMetaPayload.
          parsedCustomData.amount = agg.aggregatedAmount;
          safeLog('info', {
            event: 'meta_capi_value_aggregated',
            dispatch_job_id: job.id,
            transaction_group_id: tgid,
            event_name: event.eventName,
            event_count_in_group: agg.eventCount,
            aggregated_amount: agg.aggregatedAmount,
            original_event_amount: currentAmount,
          });
        }
      }
    }
    // === fim ONPROFIT-W4 ===

    // 4. Check eligibility — pure function, no I/O.
    // BR-DISPATCH-004: checkEligibility returns mandatory skip_reason when not eligible.
    const eligibility = checkEligibility(
      {
        consent_snapshot: parsedConsent as Parameters<
          typeof checkEligibility
        >[0]['consent_snapshot'],
        user_data: parsedUserData as Parameters<
          typeof checkEligibility
        >[0]['user_data'],
        // BR-CONSENT-003: visitor_id (cookie __fvid) conta como sinal
        // válido via Meta external_id; anônimo, não-PII.
        visitor_id: event.visitorId,
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

    // Enrich missing fbc/fbp/ip/ua/visitor_id from lead's event history.
    // Webhook events (Guru Purchase, SendFlow, etc) have no browser context —
    // fall back to signals captured by tracker.js on prior PageView/Lead
    // events of the same lead. visitor_id (cookie __fvid) maps to Meta
    // external_id e é sinal P1 de match — sem ele Purchases server-side
    // perdem dedup com browser. Caveat: se o usuário comprou em outro device
    // que o da LP, visitor_id histórico será de outro browser; ainda assim
    // Meta usa como sinal (melhor que null).
    const rawUserData = parsedUserData;
    const hasCurrentFbc = typeof rawUserData.fbc === 'string' && rawUserData.fbc.length > 0;
    const hasCurrentFbp = typeof rawUserData.fbp === 'string' && rawUserData.fbp.length > 0;
    const hasCurrentIp = typeof rawUserData.client_ip_address === 'string' && rawUserData.client_ip_address.length > 0;
    const hasCurrentUa = typeof rawUserData.client_user_agent === 'string' && rawUserData.client_user_agent.length > 0;
    const hasCurrentVisitorId = typeof event.visitorId === 'string' && event.visitorId.length > 0;
    const hasCurrentGeoCity = typeof rawUserData.geo_city === 'string' && rawUserData.geo_city.length > 0;
    const hasCurrentGeoRegion = typeof rawUserData.geo_region_code === 'string' && rawUserData.geo_region_code.length > 0;
    const hasCurrentGeoPostal = typeof rawUserData.geo_postal_code === 'string' && rawUserData.geo_postal_code.length > 0;
    const hasCurrentGeoCountry = typeof rawUserData.geo_country === 'string' && rawUserData.geo_country.length > 0;
    let enrichedFbc: string | null = null;
    let enrichedFbp: string | null = null;
    let enrichedIp: string | null = null;
    let enrichedUa: string | null = null;
    let enrichedVisitorId: string | null = null;
    let enrichedGeoCity: string | null = null;
    let enrichedGeoRegion: string | null = null;
    let enrichedGeoPostal: string | null = null;
    let enrichedGeoCountry: string | null = null;
    if (
      lead &&
      (!hasCurrentFbc ||
        !hasCurrentFbp ||
        !hasCurrentIp ||
        !hasCurrentUa ||
        !hasCurrentVisitorId ||
        !hasCurrentGeoCity ||
        !hasCurrentGeoRegion ||
        !hasCurrentGeoPostal ||
        !hasCurrentGeoCountry)
    ) {
      const historical = await lookupHistoricalBrowserSignals(
        db,
        event.workspaceId,
        lead.id,
      );
      if (!hasCurrentFbc) enrichedFbc = historical.fbc;
      if (!hasCurrentFbp) enrichedFbp = historical.fbp;
      if (!hasCurrentIp) enrichedIp = historical.ip;
      if (!hasCurrentUa) enrichedUa = historical.ua;
      if (!hasCurrentVisitorId) enrichedVisitorId = historical.visitor_id;
      // GEO-CITY-ENRICHMENT-GAP (2026-05-09): geo herda do histórico do
      // tracker.js quando webhook não traz contact.address. Fecha o último
      // gap pra match score 8/8 em Purchases Guru de leads que passaram
      // pela LP antes.
      if (!hasCurrentGeoCity) enrichedGeoCity = historical.geo_city;
      if (!hasCurrentGeoRegion) enrichedGeoRegion = historical.geo_region_code;
      if (!hasCurrentGeoPostal) enrichedGeoPostal = historical.geo_postal_code;
      if (!hasCurrentGeoCountry) enrichedGeoCountry = historical.geo_country;
      if (
        enrichedFbc ||
        enrichedFbp ||
        enrichedIp ||
        enrichedUa ||
        enrichedVisitorId ||
        enrichedGeoCity ||
        enrichedGeoRegion ||
        enrichedGeoPostal ||
        enrichedGeoCountry
      ) {
        safeLog('info', {
          event: 'meta_capi_browser_signals_enriched',
          dispatch_job_id: job.id,
          enriched_fbc: !!enrichedFbc,
          enriched_fbp: !!enrichedFbp,
          enriched_ip: !!enrichedIp,
          enriched_ua: !!enrichedUa,
          enriched_visitor_id: !!enrichedVisitorId,
          enriched_geo_city: !!enrichedGeoCity,
          enriched_geo_region: !!enrichedGeoRegion,
          enriched_geo_postal: !!enrichedGeoPostal,
          enriched_geo_country: !!enrichedGeoCountry,
        });
      }
    }

    // Hash geo fields for Meta CAPI (SHA-256 pure, no workspace scope).
    // Normalization: city lowercase trim, state 2-letter lowercase,
    // zip digits-only, country 2-letter lowercase.
    // GEO-CITY-ENRICHMENT-GAP: prefere geo do evento, fallback enriquecido.
    const geoCity = (typeof rawUserData.geo_city === 'string' ? rawUserData.geo_city : null) ?? enrichedGeoCity;
    const geoRegionCode = (typeof rawUserData.geo_region_code === 'string' ? rawUserData.geo_region_code : null) ?? enrichedGeoRegion;
    const geoPostalCode = (typeof rawUserData.geo_postal_code === 'string' ? rawUserData.geo_postal_code : null) ?? enrichedGeoPostal;
    const geoCountry = (typeof rawUserData.geo_country === 'string' ? rawUserData.geo_country : null) ?? enrichedGeoCountry;
    const [ctHash, stHash, zpHash, countryHash] = await Promise.all([
      geoCity ? hashPiiExternal(geoCity.toLowerCase().trim()) : Promise.resolve(null),
      geoRegionCode ? hashPiiExternal(geoRegionCode.toLowerCase()) : Promise.resolve(null),
      geoPostalCode ? hashPiiExternal(geoPostalCode.replace(/\D/g, '')) : Promise.resolve(null),
      geoCountry ? hashPiiExternal(geoCountry.toLowerCase()) : Promise.resolve(null),
    ]);

    const payload = mapEventToMetaPayload(
      {
        event_id: event.eventId,
        event_name: event.eventName,
        event_time: event.eventTime,
        lead_id: event.leadId,
        workspace_id: event.workspaceId,
        // BR-CONSENT-003: visitor_id mapeia para Meta external_id (PLANO).
        // Webhook Purchases não trazem visitor_id; usamos enriquecido do
        // histórico tracker.js do mesmo lead quando disponível.
        visitor_id: event.visitorId ?? enrichedVisitorId,
        user_data: {
          ...(rawUserData as Parameters<typeof mapEventToMetaPayload>[0]['user_data']),
          ...(enrichedFbc ? { fbc: enrichedFbc } : {}),
          ...(enrichedFbp ? { fbp: enrichedFbp } : {}),
          ...(enrichedIp ? { client_ip_address: enrichedIp } : {}),
          ...(enrichedUa ? { client_user_agent: enrichedUa } : {}),
          ...(ctHash ? { ct: ctHash } : {}),
          ...(stHash ? { st: stHash } : {}),
          ...(zpHash ? { zp: zpHash } : {}),
          ...(countryHash ? { country: countryHash } : {}),
        },
        // ONPROFIT-W4: usa parsedCustomData local (pode ter sido mutado pelo
        // agregador acima — campo `amount` consolidado dos order bumps).
        custom_data: parsedCustomData as Parameters<
          typeof mapEventToMetaPayload
        >[0]['custom_data'],
        event_source_url: eventSourceUrl,
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
    // T-DISPATCH-PAYLOAD-AUDIT (2026-05-09): anexa request/response para
    // gravação em dispatch_attempts.{request,response}_payload_sanitized.
    // Sanitização (IP redact) é aplicada em processDispatchJob como última
    // camada (defense-in-depth) — não precisa redactar aqui.
    if (capiResult.ok) {
      return { ok: true, request: payload, response: capiResult.data };
    }
    // Non-ok results have the same shape as DispatchResult — pass through directly,
    // anexando request enviado e responseBody (quando capturado pelo client).
    const { responseBody, ...rest } = capiResult as Extract<
      typeof capiResult,
      { ok: false }
    > & { responseBody?: unknown };
    return { ...rest, request: payload, response: responseBody };
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
    const [rawEvent] = await db
      .select()
      .from(events)
      .where(eq(events.id, job.eventId));

    if (!rawEvent) {
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

    // 2b. OQ-012 closure (T-16-002A): 4-level cascade for GA4 client_id.
    //   1. self           — resolveClientId on rawEvent.user_data
    //   2. sibling        — same lead_id, received_at < current, with _ga/fvid
    //   3. cross_lead     — same workspace, matching phone_hash_external (1st)
    //                       or email_hash_external (2nd), received_at < current
    //   4. deterministic  — SHA-256(workspace_id:lead_id) → GA1.1.<8d>.<10d>
    //
    // Skip with skip_reason='no_client_id_unresolvable' only when lead_id is
    // absent (extremely rare). With a lead_id we always reach a stable id.
    //
    // Detail: docs/40-integrations/06-ga4-measurement-protocol.md §3,
    //         docs/90-meta/03-open-questions-log.md OQ-012.
    // BR-CONSENT-004: analytics consent gate enforced by checkGa4Eligibility below.

    // Defensive parse — userData column is jsonb but legacy paths may have
    // landed it as a JSON string; handle both gracefully.
    const parseUd = (raw: unknown): Record<string, unknown> | null => {
      if (raw == null) return null;
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
      if (typeof raw === 'object') return raw as Record<string, unknown>;
      return null;
    };

    const rawUserData = parseUd(rawEvent.userData) ?? {};

    // Level 2: sibling lookup — same lead, strictly earlier event with _ga / fvid.
    let siblingUserData: Record<string, unknown> | null = null;
    if (job.leadId) {
      const [sibling] = await db
        .select({ userData: events.userData })
        .from(events)
        .where(
          and(
            eq(events.leadId, job.leadId),
            ne(events.id, rawEvent.id),
            lt(events.receivedAt, rawEvent.receivedAt),
          ),
        )
        .orderBy(desc(events.receivedAt))
        .limit(1);
      if (sibling) {
        siblingUserData = parseUd(sibling.userData);
      }
    }

    // Level 3: cross-lead lookup — phone_hash_external first, email second.
    // BR-PRIVACY-002: hashes only; no PII in clear at any step.
    let crossLeadUserData: Record<string, unknown> | null = null;
    if (lead && (lead.phoneHashExternal || lead.emailHashExternal)) {
      const tryByHash = async (
        column: 'phoneHashExternal' | 'emailHashExternal',
        hash: string,
      ): Promise<Record<string, unknown> | null> => {
        const [row] = await db
          .select({ userData: events.userData })
          .from(events)
          .innerJoin(leads, eq(leads.id, events.leadId))
          .where(
            and(
              eq(leads.workspaceId, rawEvent.workspaceId),
              ne(leads.id, lead.id),
              eq(leads[column], hash),
              lt(events.receivedAt, rawEvent.receivedAt),
            ),
          )
          .orderBy(desc(events.receivedAt))
          .limit(1);
        return row ? parseUd(row.userData) : null;
      };

      if (lead.phoneHashExternal) {
        crossLeadUserData = await tryByHash(
          'phoneHashExternal',
          lead.phoneHashExternal,
        );
      }
      if (!crossLeadUserData && lead.emailHashExternal) {
        crossLeadUserData = await tryByHash(
          'emailHashExternal',
          lead.emailHashExternal,
        );
      }
    }

    // Cascade resolver (pure) — produces the final client_id + source label.
    const resolution = await resolveClientIdExtended({
      user_data: rawUserData as ClientIdUserData,
      sibling_user_data: siblingUserData as ClientIdUserData | null,
      cross_lead_user_data: crossLeadUserData as ClientIdUserData | null,
      lead_id: job.leadId ?? null,
      workspace_id: rawEvent.workspaceId,
    });

    // Enrich user_data with the resolved client_id so downstream eligibility
    // and mapper see a populated client_id_ga4. We intentionally overwrite
    // any prior value because resolveClientIdExtended already preferred it
    // when present (level 1: self).
    let event = rawEvent;
    if (resolution.client_id) {
      event = {
        ...rawEvent,
        userData: {
          ...rawUserData,
          client_id_ga4: resolution.client_id,
        },
      };
    }

    // Observability — BR-PRIVACY-001: only the source label is logged, no PII
    // and no client_id value (which is a stable user identifier in GA4).
    safeLog('info', {
      event: 'ga4_client_id_resolved',
      dispatch_job_id: job.id,
      source: resolution.source,
    });

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
      // T-16-002A: when the cascade exhausted all 4 levels (lead_id absent),
      // promote 'no_client_id' to the more informative
      // 'no_client_id_unresolvable' so dashboards distinguish the legitimate
      // unresolvable case (no lead) from any future regressions.
      const reason =
        eligibility.reason === 'no_client_id' &&
        resolution.source === 'unresolved'
          ? 'no_client_id_unresolvable'
          : eligibility.reason;
      return { ok: false, kind: 'skip', reason };
    }

    // 4. Map internal event → Ga4MpPayload.
    // ONPROFIT-W5: mesma agregação do Meta CAPI — consolida Purchase value
    // por transaction_group_id antes de mapear. BR-DISPATCH-007.
    const ga4ParsedCustomData = parseUd(event.customData) ?? {};
    {
      const tgid =
        typeof ga4ParsedCustomData.transaction_group_id === 'string'
          ? ga4ParsedCustomData.transaction_group_id
          : null;
      const itemType =
        typeof ga4ParsedCustomData.item_type === 'string'
          ? ga4ParsedCustomData.item_type
          : null;
      const currentAmount =
        typeof ga4ParsedCustomData.amount === 'number'
          ? ga4ParsedCustomData.amount
          : 0;
      if (
        (event.eventName === 'Purchase' || event.eventName === 'InitiateCheckout') &&
        tgid &&
        (itemType === 'product' || itemType === null)
      ) {
        const agg = await aggregatePurchaseValueByGroup({
          db,
          workspaceId: event.workspaceId,
          transactionGroupId: tgid,
          eventName: event.eventName,
          currentEventAmount: currentAmount,
        });
        if (agg.isAggregated) {
          ga4ParsedCustomData.amount = agg.aggregatedAmount;
          safeLog('info', {
            event: 'ga4_value_aggregated',
            dispatch_job_id: job.id,
            transaction_group_id: tgid,
            event_name: event.eventName,
            event_count_in_group: agg.eventCount,
            aggregated_amount: agg.aggregatedAmount,
          });
        }
      }
    }
    const payload = mapEventToGa4Payload(
      {
        event_id: event.eventId,
        event_name: event.eventName,
        event_time: event.eventTime,
        lead_id: event.leadId,
        workspace_id: event.workspaceId,
        user_data: event.userData as Parameters<
          typeof mapEventToGa4Payload
        >[0]['user_data'],
        custom_data: ga4ParsedCustomData as Parameters<
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

    // T-DISPATCH-PAYLOAD-AUDIT: anexa request para gravação em
    // dispatch_attempts.request_payload_sanitized (BR-DISPATCH-007).
    // GA4 MP retorna 204 No Content em sucesso → response fica vazio
    // (campo cliente não exposto pelo client). Em failure, GA4 não traz
    // body útil — error_code já vai em dispatch_attempts.error_code.
    if (ga4Result.ok) {
      return { ok: true, request: payload };
    }
    return { ...ga4Result, request: payload };
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
 *   2. Resolves per-workspace Google Ads access_token via getGoogleAdsAccessToken
 *      (T-14-009-FOLLOWUP, 2026-05-09): cached + invalid_grant aware. Substitui
 *      o caminho legado via resolveGoogleAdsCredentials + refresh interno do
 *      client.ts — agora classifica oauth_token_revoked corretamente (skip
 *      permanente actionable) em vez de server_error (retry inútil).
 *   3. Builds a virtual launchConfig using job.destinationAccountId (customer_id)
 *      + job.destinationResourceId (conversion_action_id) — workspace-level
 *      mapping resolved at enqueue time (T-14-008).
 *   4. Checks eligibility (consent, click_id, conversion_action, customer_id).
 *   5. Maps to ConversionUploadPayload via mapEventToConversionUpload.
 *   6. Calls sendConversionUpload com `accessToken` direto (sem refresh interno).
 *
 * T-14-009 (Sprint 14, Onda 3) — migrated from env-var-based credentials
 *   (GOOGLE_ADS_CLIENT_ID/SECRET/REFRESH_TOKEN/DEVELOPER_TOKEN/CUSTOMER_ID) to
 *   per-workspace credentials persisted via OAuth flow (T-14-005).
 * T-14-009-FOLLOWUP (2026-05-09) — token resolution via getGoogleAdsAccessToken
 *   para paridade com buildEnhancedConversionDispatchFn. Reduz ~200ms de latência
 *   por dispatch (cache de access_token entre invocações da mesma instância)
 *   e habilita classificação correta de invalid_grant.
 *
 * BR-DISPATCH-002: processDispatchJob already holds the atomic lock before calling this.
 * BR-DISPATCH-004: checkEligibility provides mandatory skip_reason on ineligible.
 * BR-CONSENT-003: ad_user_data consent enforced by checkGoogleAdsEligibility.
 * BR-PRIVACY-001: no PII (and no token material) logged.
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

    // 2. Resolve per-workspace Google Ads access_token (cached + invalid_grant aware).
    // T-14-009-FOLLOWUP (2026-05-09): mesmo helper usado por
    // buildEnhancedConversionDispatchFn — invalid_grant marca
    // workspace.oauth_token_state='expired' e retorna oauth_token_revoked
    // (skip permanente actionable) em vez de mascarar como server_error.
    const tokenResult = await getGoogleAdsAccessToken({
      db,
      workspaceId: event.workspaceId,
      masterKeyRegistry: { 1: env.PII_MASTER_KEY_V1 ?? '' },
      envDeveloperToken: env.GOOGLE_ADS_DEVELOPER_TOKEN ?? null,
      oauthClientId: env.GOOGLE_OAUTH_CLIENT_ID ?? env.GOOGLE_ADS_CLIENT_ID,
      oauthClientSecret:
        env.GOOGLE_OAUTH_CLIENT_SECRET ?? env.GOOGLE_ADS_CLIENT_SECRET,
      fetchFn: fetch,
    });

    if (!tokenResult.ok) {
      switch (tokenResult.error.code) {
        case 'not_configured':
          // BR-DISPATCH-004: skip_reason mandatory.
          return {
            ok: false,
            kind: 'skip',
            reason: 'integration_not_configured',
          };
        case 'invalid_state':
          // OAuth flow not finished (state != 'connected').
          return { ok: false, kind: 'skip', reason: 'oauth_pending' };
        case 'oauth_token_revoked':
          // T-14-009-FOLLOWUP: skip permanente — UI mostra "Reconectar Google Ads".
          return { ok: false, kind: 'skip', reason: 'oauth_token_revoked' };
        case 'oauth_refresh_failed':
        case 'decryption_failed':
        case 'db_error':
          // Transient — retry later (KMS/DB/Google hiccup).
          return { ok: false, kind: 'server_error', status: 0 };
      }
    }

    // 3. Build virtual launchConfig from dispatch_job — destinationAccountId is
    //    the workspace-level Google Ads customer_id, destinationResourceId is
    //    the conversion_action_id resolved at enqueue (T-14-008).
    //    Eligibility + mapper expect this shape (launches-scoped config); we
    //    surface the workspace-scoped values through the same surface so neither
    //    function needs to learn about the dispatch_job.
    const virtualLaunchConfig: {
      tracking: {
        google: {
          ads_customer_id: string | null;
          conversion_actions: Record<string, string>;
        };
      };
    } = {
      tracking: {
        google: {
          ads_customer_id:
            job.destinationAccountId ?? tokenResult.value.customerId,
          conversion_actions: job.destinationResourceId
            ? { [event.eventName]: job.destinationResourceId }
            : {},
        },
      },
    };

    // 4. Check eligibility — pure function, no I/O.
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
      virtualLaunchConfig,
    );

    if (!eligibility.eligible) {
      // BR-DISPATCH-004: skip_reason is mandatory when skipping.
      return { ok: false, kind: 'skip', reason: eligibility.reason };
    }

    // 5. Map internal event → ConversionUploadPayload.
    // ONPROFIT-W5: consolida Purchase value por transaction_group_id antes de
    // mapear. Google Ads recebe valor total (main + OBs). BR-DISPATCH-007.
    const gadsConvParseUd = (raw: unknown): Record<string, unknown> => {
      if (raw == null) return {};
      if (typeof raw === 'string') { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; } }
      if (typeof raw === 'object') return raw as Record<string, unknown>;
      return {};
    };
    const gadsConvParsedCustomData = gadsConvParseUd(event.customData);
    {
      const tgid =
        typeof gadsConvParsedCustomData.transaction_group_id === 'string'
          ? gadsConvParsedCustomData.transaction_group_id
          : null;
      const itemType =
        typeof gadsConvParsedCustomData.item_type === 'string'
          ? gadsConvParsedCustomData.item_type
          : null;
      const currentAmount =
        typeof gadsConvParsedCustomData.amount === 'number'
          ? gadsConvParsedCustomData.amount
          : 0;
      if (
        (event.eventName === 'Purchase' || event.eventName === 'InitiateCheckout') &&
        tgid &&
        (itemType === 'product' || itemType === null)
      ) {
        const agg = await aggregatePurchaseValueByGroup({
          db,
          workspaceId: event.workspaceId,
          transactionGroupId: tgid,
          eventName: event.eventName,
          currentEventAmount: currentAmount,
        });
        if (agg.isAggregated) {
          gadsConvParsedCustomData.amount = agg.aggregatedAmount;
          safeLog('info', {
            event: 'gads_conversion_value_aggregated',
            dispatch_job_id: job.id,
            transaction_group_id: tgid,
            event_name: event.eventName,
            event_count_in_group: agg.eventCount,
            aggregated_amount: agg.aggregatedAmount,
          });
        }
      }
    }
    const payload = mapEventToConversionUpload(
      {
        event_id: event.eventId,
        event_name: event.eventName,
        event_time: event.eventTime,
        workspace_id: event.workspaceId,
        attribution: event.attribution as Parameters<
          typeof mapEventToConversionUpload
        >[0]['attribution'],
        custom_data: gadsConvParsedCustomData as Parameters<
          typeof mapEventToConversionUpload
        >[0]['custom_data'],
      },
      virtualLaunchConfig,
    );

    // 6. Send com accessToken direto (T-14-009-FOLLOWUP).
    // BR-PRIVACY-001: no logging of tokens.
    const gadsResult = await sendConversionUpload(
      payload,
      {
        accessToken: tokenResult.value.accessToken,
        developerToken: tokenResult.value.developerToken,
        customerId: tokenResult.value.customerId,
        managerCustomerId: tokenResult.value.loginCustomerId,
      },
      fetch,
    );

    // T-DISPATCH-PAYLOAD-AUDIT: anexa request para gravação em
    // dispatch_attempts.request_payload_sanitized (BR-DISPATCH-007).
    // Google Ads response em sucesso é parseado pelo client mas não
    // exposto na assinatura atual — incremental: passar response body
    // requer estender GoogleAdsResult (similar ao MetaCapiResult).
    if (gadsResult.ok) {
      return { ok: true, request: payload };
    }
    return { ...gadsResult, request: payload };
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
 *   3. Resolves a per-workspace Google Ads access_token via getGoogleAdsAccessToken
 *      (cached, with invalid_grant detection that marks oauth_token_state='expired').
 *   4. Builds a virtual launchConfig from dispatch_job (destinationAccountId +
 *      destinationResourceId) — workspace-level mapping resolved at enqueue (T-14-008).
 *   5. Checks eligibility (consent, order_id, user_data, conversion_action, 24h window).
 *   6. Maps to EnhancedConversionPayload via mapEventToEnhancedConversion.
 *   7. Calls sendEnhancedConversion with the access_token directly (no inner refresh).
 *
 * T-14-009 (Sprint 14, Onda 3) — migrated from env-var-based credentials
 *   to per-workspace credentials persisted via OAuth flow (T-14-005).
 *
 * BR-DISPATCH-002: processDispatchJob already holds the atomic lock before calling this.
 * BR-DISPATCH-004: checkEligibility provides mandatory skip_reason on ineligible.
 * BR-CONSENT-003: ad_user_data consent enforced by checkEnhancedEligibility.
 * BR-PRIVACY-001: no PII (and no token material) logged.
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

    // 3. Resolve per-workspace access_token (cached + invalid_grant aware).
    //    T-14-006: getGoogleAdsAccessToken handles refresh + caches per workspace_id.
    //    On invalid_grant, the helper marks oauth_token_state='expired' before returning
    //    the typed error — UI then surfaces "Reconectar Google Ads".
    const tokenResult = await getGoogleAdsAccessToken({
      db,
      workspaceId: event.workspaceId,
      masterKeyRegistry: { 1: env.PII_MASTER_KEY_V1 ?? '' },
      envDeveloperToken: env.GOOGLE_ADS_DEVELOPER_TOKEN ?? null,
      oauthClientId:
        env.GOOGLE_OAUTH_CLIENT_ID ?? env.GOOGLE_ADS_CLIENT_ID,
      oauthClientSecret:
        env.GOOGLE_OAUTH_CLIENT_SECRET ?? env.GOOGLE_ADS_CLIENT_SECRET,
      fetchFn: fetch,
    });

    if (!tokenResult.ok) {
      switch (tokenResult.error.code) {
        case 'not_configured':
          return {
            ok: false,
            kind: 'skip',
            reason: 'integration_not_configured',
          };
        case 'invalid_state':
          return { ok: false, kind: 'skip', reason: 'oauth_pending' };
        case 'oauth_token_revoked':
          return {
            ok: false,
            kind: 'skip',
            reason: 'oauth_token_revoked',
          };
        case 'oauth_refresh_failed':
        case 'decryption_failed':
        case 'db_error':
          // Transient — retry later. server_error kind triggers backoff retry.
          return { ok: false, kind: 'server_error', status: 0 };
      }
    }

    // 4. Build virtual launchConfig from dispatch_job — same pattern as
    //    Conversion Upload. eligibility + mapper expect launches-scoped shape.
    const virtualLaunchConfig: EnhancedConversionsLaunchConfig = {
      tracking: {
        google: {
          ads_customer_id:
            job.destinationAccountId ?? tokenResult.value.customerId,
          conversion_actions: job.destinationResourceId
            ? { [event.eventName]: job.destinationResourceId }
            : {},
        },
      },
    };

    // ONPROFIT-W5: consolida Purchase value por transaction_group_id antes de
    // eligibility + mapper. BR-DISPATCH-007.
    const enhParseUd = (raw: unknown): Record<string, unknown> => {
      if (raw == null) return {};
      if (typeof raw === 'string') { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; } }
      if (typeof raw === 'object') return raw as Record<string, unknown>;
      return {};
    };
    const enhParsedCustomData = enhParseUd(event.customData);
    {
      const tgid =
        typeof enhParsedCustomData.transaction_group_id === 'string'
          ? enhParsedCustomData.transaction_group_id
          : null;
      const itemType =
        typeof enhParsedCustomData.item_type === 'string'
          ? enhParsedCustomData.item_type
          : null;
      const currentAmount =
        typeof enhParsedCustomData.amount === 'number'
          ? enhParsedCustomData.amount
          : 0;
      if (
        (event.eventName === 'Purchase' || event.eventName === 'InitiateCheckout') &&
        tgid &&
        (itemType === 'product' || itemType === null)
      ) {
        const agg = await aggregatePurchaseValueByGroup({
          db,
          workspaceId: event.workspaceId,
          transactionGroupId: tgid,
          eventName: event.eventName,
          currentEventAmount: currentAmount,
        });
        if (agg.isAggregated) {
          enhParsedCustomData.amount = agg.aggregatedAmount;
          safeLog('info', {
            event: 'enhanced_conversion_value_aggregated',
            dispatch_job_id: job.id,
            transaction_group_id: tgid,
            event_name: event.eventName,
            event_count_in_group: agg.eventCount,
            aggregated_amount: agg.aggregatedAmount,
          });
        }
      }
    }

    // 5. Check eligibility — pure function, no I/O.
    // BR-CONSENT-003: ad_user_data consent required for Enhanced Conversions.
    // BR-DISPATCH-004: checkEligibility returns mandatory skip_reason when not eligible.
    const eligibility = checkEnhancedEligibility(
      {
        event_name: event.eventName,
        event_time: event.eventTime,
        consent_snapshot: event.consentSnapshot as Parameters<
          typeof checkEnhancedEligibility
        >[0]['consent_snapshot'],
        custom_data: enhParsedCustomData as Parameters<
          typeof checkEnhancedEligibility
        >[0]['custom_data'],
      },
      lead ? { email_hash: lead.emailHash, phone_hash: lead.phoneHash } : null,
      virtualLaunchConfig,
    );

    if (!eligibility.eligible) {
      // BR-DISPATCH-004: skip_reason is mandatory when skipping.
      return { ok: false, kind: 'skip', reason: eligibility.reason };
    }

    // 6. Map internal event → EnhancedConversionPayload.
    const enhancedRawUserData = (event.userData ?? {}) as Record<string, unknown>;
    const payload = mapEventToEnhancedConversion(
      {
        event_id: event.eventId,
        event_name: event.eventName,
        event_time: event.eventTime,
        lead_id: event.leadId,
        workspace_id: event.workspaceId,
        custom_data: enhParsedCustomData as Parameters<
          typeof mapEventToEnhancedConversion
        >[0]['custom_data'],
        consent_snapshot: event.consentSnapshot as Parameters<
          typeof mapEventToEnhancedConversion
        >[0]['consent_snapshot'],
        // Raw geo — Google normalizes/hashes on their end (no pre-hash needed).
        geo: {
          city: typeof enhancedRawUserData.geo_city === 'string' ? enhancedRawUserData.geo_city : null,
          region_code: typeof enhancedRawUserData.geo_region_code === 'string' ? enhancedRawUserData.geo_region_code : null,
          postal_code: typeof enhancedRawUserData.geo_postal_code === 'string' ? enhancedRawUserData.geo_postal_code : null,
          country: typeof enhancedRawUserData.geo_country === 'string' ? enhancedRawUserData.geo_country : null,
        },
      },
      lead
        ? {
            email_hash_external: lead.emailHashExternal,
            phone_hash_external: lead.phoneHashExternal,
            fn_hash: lead.fnHash,
            ln_hash: lead.lnHash,
          }
        : null,
      virtualLaunchConfig,
    );

    // 7. Send — sendEnhancedConversion accepts accessToken directly (no inner refresh).
    const enhancedResult = await sendEnhancedConversion(
      payload,
      {
        customerId: tokenResult.value.customerId,
        developerToken: tokenResult.value.developerToken,
        accessToken: tokenResult.value.accessToken,
      },
      fetch,
    );

    // T-DISPATCH-PAYLOAD-AUDIT: anexa request para gravação em
    // dispatch_attempts.request_payload_sanitized (BR-DISPATCH-007).
    if (enhancedResult.ok) {
      return { ok: true, request: payload };
    }
    return { ...enhancedResult, request: payload };
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

  // ---------------------------------------------------------------------------
  // */10 * * * * — outbox poller: re-queues raw_events stuck in pending
  //
  // Covers two failure modes:
  //   a) QUEUE_EVENTS.send() threw at ingestion time (message never enqueued)
  //   b) processRawEvent failed and queue exhausted its retries (message dropped)
  //
  // Window: events pending between 10 min and 24 h. Beyond 24 h the event is
  // considered permanently broken — it surfaces in the stuck_pending_events log
  // for manual investigation instead of being retried indefinitely.
  // ---------------------------------------------------------------------------
  if (cron === '*/10 * * * *') {
    const stuck = await db
      .select({
        id: rawEvents.id,
        workspaceId: rawEvents.workspaceId,
        pageId: rawEvents.pageId,
        receivedAt: rawEvents.receivedAt,
      })
      .from(rawEvents)
      .where(
        and(
          eq(rawEvents.processingStatus, 'pending'),
          lt(rawEvents.receivedAt, sql`now() - interval '10 minutes'`),
          lt(sql`now() - interval '24 hours'`, rawEvents.receivedAt),
        ),
      )
      .limit(500);

    let requeued = 0;
    let failed = 0;
    for (const ev of stuck) {
      try {
        await env.QUEUE_EVENTS.send({
          raw_event_id: ev.id,
          workspace_id: ev.workspaceId,
          page_id: ev.pageId,
          received_at: ev.receivedAt.toISOString(),
        });
        requeued++;
      } catch {
        failed++;
      }
    }

    safeLog('info', {
      event: 'outbox_poll_completed',
      stuck_total: stuck.length,
      requeued,
      enqueue_failed: failed,
    });

    const permanentlyStuck = await db
      .select({ id: rawEvents.id, receivedAt: rawEvents.receivedAt })
      .from(rawEvents)
      .where(
        and(
          eq(rawEvents.processingStatus, 'pending'),
          lt(rawEvents.receivedAt, sql`now() - interval '24 hours'`),
        ),
      )
      .limit(50);

    if (permanentlyStuck.length > 0) {
      safeLog('warn', {
        event: 'stuck_pending_events',
        count: permanentlyStuck.length,
        oldest_received_at: permanentlyStuck[0]?.receivedAt,
      });
    }

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
