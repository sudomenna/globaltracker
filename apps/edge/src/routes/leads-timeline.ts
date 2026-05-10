/**
 * routes/leads-timeline.ts — GET /v1/leads/:public_id/timeline
 *
 * Returns a cursor-paginated, role-sanitized timeline of all domain events
 * for a given lead, identified by its public_id.
 *
 * CONTRACT-api-leads-timeline-v1 (T-6-010)
 *
 * Node sources (implemented):
 *   - events          → type: 'event'
 *   - dispatch_jobs   → type: 'dispatch' (with latest dispatch_attempt joined)
 *   - lead_attributions → type: 'attribution'
 *   - lead_stages     → type: 'stage'
 *
 * Node sources (TODO):
 *   - lead_consents   → type: 'consent'   (see placeholder below)
 *   - audit_log SAR   → type: 'sar'       (Sprint 7 — requires audit_log table)
 *
 * Auth (Sprint 6 simplified):
 *   Requires `Authorization: Bearer <token>` header — non-empty.
 *   Missing / empty → 401.
 *
 * RBAC / payload sanitization (BR-PRIVACY-001):
 *   MARKETER  — sanitized payload (no request_body, response_body, idempotency_key)
 *   OPERATOR/ADMIN — full payload including da.response_code, da.error_code, dj.idempotency_key
 *   Role extracted from context (set by auth middleware). Fallback: 'marketer' (most restrictive).
 *
 * Pagination:
 *   cursor = ISO timestamp; only nodes with timestamp < cursor are returned.
 *   next_cursor = ISO timestamp of the last node returned, or null when no more pages.
 *
 * BR-PRIVACY-001: zero PII in logs and error responses.
 *
 * ORCHESTRATOR MOUNT (adicionar em apps/edge/src/index.ts após as outras rotas):
 * import { leadsTimelineRoute } from './routes/leads-timeline.js';
 * app.route('/v1/leads', leadsTimelineRoute);
 */

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { auditLog, createDb, leads, workspaceMembers } from '@globaltracker/db';
import { z } from 'zod';
import { createLeadsQueryFns } from '../lib/leads-queries.js';
import {
  LIFECYCLE_STATUSES,
  type LifecycleStatus,
} from '../lib/lifecycle-rules.js';
import { maskEmail, maskPhone } from '../lib/pii-mask.js';
import {
  canRevealPii,
  canSeePiiPlainByDefault,
  isValidRole,
  type WorkspaceRole,
} from '../lib/rbac.js';
import {
  supabaseJwtMiddleware,
  type LookupWorkspaceMemberFn,
} from '../middleware/auth-supabase-jwt.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env / context types
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
  DATABASE_URL?: string;
  PII_MASTER_KEY_V1?: string;
  DEV_WORKSPACE_ID?: string;
  SUPABASE_URL?: string;
};

type AppVariables = {
  workspace_id?: string;
  request_id?: string;
  /** Role injected by auth middleware in Sprint 6 full auth. */
  role?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Query parameter schema
// ---------------------------------------------------------------------------

const TimelineQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(50).default(50),
  filters: z.string().optional(), // JSON string: { types?: string[], statuses?: string[] }
  since: z.string().optional(), // ISO timestamp — exclude nodes older than this
});

// List query schema — keeps existing behaviour, adds optional lifecycle filter
// (T-PRODUCTS-006). lifecycle_status is not PII (BR-PRIVACY-001), safe to expose.
const ListLeadsQuerySchema = z
  .object({
    q: z.string().optional(),
    launch_public_id: z.string().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().min(1).max(100).optional(),
    lifecycle: z
      .enum(LIFECYCLE_STATUSES as readonly [LifecycleStatus, ...LifecycleStatus[]])
      .optional(),
    sort_by: z
      .enum(['last_seen_at', 'first_seen_at', 'name', 'lifecycle_status'])
      .optional(),
    sort_dir: z.enum(['asc', 'desc']).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// TimelineNode type
// ---------------------------------------------------------------------------


export type TimelineNode = {
  id: string;
  // CP client NodeType compound names
  type:
    | 'event_captured'
    | 'dispatch_queued'
    | 'dispatch_success'
    | 'dispatch_failed'
    | 'dispatch_skipped'
    | 'attribution_set'
    | 'stage_changed'
    | 'merge'
    | 'consent_updated'
    | 'tag_added';
  occurred_at: string;
  // CP client NodeStatus
  status: 'ok' | 'failed' | 'skipped' | 'pending';
  label: string;
  detail?: string;
  destination?: string;
  job_id?: string;
  payload: Record<string, unknown>;
  skip_reason: string | null;
  can_replay: boolean;
};

export type TimelineResponse = {
  lead_public_id: string;
  nodes: TimelineNode[];
  next_cursor: string | null;
  total_count: number;
};

// ---------------------------------------------------------------------------
// DB row types (minimal — derived from Drizzle schema shape)
// ---------------------------------------------------------------------------

type EventRow = {
  id: string;
  eventName: string;
  eventTime: Date;
  receivedAt: Date;
  pageId: string | null;
  attribution: unknown;
  // T-17-001: enrichment fields
  eventSource?: string | null;
  customData?: unknown;
  processingStatus?: string | null;
  pageName?: string | null;
  launchName?: string | null;
};

type DispatchJobRow = {
  id: string;
  eventId: string | null;
  destination: string;
  status: string;
  skipReason: string | null;
  idempotencyKey: string;
  nextAttemptAt: Date | null;
  createdAt: Date;
  // Joined from dispatch_attempts (latest attempt)
  responseStatus: number | null;
  errorCode: string | null;
  // T-17-002: enrichment fields
  destinationResourceId?: string | null;
  attemptCount?: number | null;
  requestPayloadSanitized?: unknown;
  replayedFromDispatchJobId?: string | null;
};

type LeadAttributionRow = {
  id: string;
  touchType: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  createdAt: Date;
  // T-17-003: enrichment fields
  content?: string | null;
  term?: string | null;
  fbclid?: string | null;
  gclid?: string | null;
  adId?: string | null;
  campaignId?: string | null;
  linkId?: string | null;
};

type LeadStageRow = {
  id: string;
  stage: string;
  ts: Date;
  // T-17-003: enrichment fields
  fromStage?: string | null;
  sourceEventId?: string | null;
  launchId?: string | null;
  isRecurring?: boolean | null;
  // funnel_role omitted: column does not exist on lead_stages schema (T-17-003 gap)
};

// T-17-004: tag_added node source
type LeadTagRow = {
  id: string;
  tagName: string;
  setAt: Date;
  setBy: string;
};

// T-17-004: consent_updated node source
type LeadConsentRow = {
  id: string;
  ts: Date;
  source: string;
  policyVersion: string;
  consentAnalytics: string;
  consentMarketing: string;
  consentAdUserData: string;
  consentAdPersonalization: string;
  consentCustomerMatch: string;
  // optional: previous row to compute purposes_diff (when omitted, full snapshot is exposed)
  prev?: {
    consentAnalytics: string;
    consentMarketing: string;
    consentAdUserData: string;
    consentAdPersonalization: string;
    consentCustomerMatch: string;
  } | null;
};

// T-17-004: merge node source
type LeadMergeRow = {
  id: string;
  mergedAt: Date;
  reason: string;
  performedBy: string;
  beforeSummary: unknown;
  afterSummary: unknown;
  primaryLeadPublicId: string;
  mergedLeadPublicId: string;
};

// ---------------------------------------------------------------------------
// DB query function types (injected via factory — no direct DB coupling)
// ---------------------------------------------------------------------------

/** Lookup result for lead by public_id within a workspace. */
export type LeadLookupResult =
  | { found: false }
  | { found: true; leadId: string };

export type GetLeadByPublicIdFn = (
  publicId: string,
  workspaceId: string,
) => Promise<LeadLookupResult>;

export type GetEventsFn = (opts: {
  leadId: string;
  workspaceId: string;
  cursor: Date | null;
  limit: number;
}) => Promise<EventRow[]>;

export type GetDispatchJobsFn = (opts: {
  leadId: string;
  workspaceId: string;
  cursor: Date | null;
  limit: number;
}) => Promise<DispatchJobRow[]>;

export type GetLeadAttributionsFn = (opts: {
  leadId: string;
  workspaceId: string;
}) => Promise<LeadAttributionRow[]>;

export type GetLeadStagesFn = (opts: {
  leadId: string;
  workspaceId: string;
}) => Promise<LeadStageRow[]>;

// T-17-004: new node sources
export type GetLeadTagsFn = (opts: {
  leadId: string;
  workspaceId: string;
}) => Promise<LeadTagRow[]>;

export type GetLeadConsentsFn = (opts: {
  leadId: string;
  workspaceId: string;
}) => Promise<LeadConsentRow[]>;

export type GetLeadMergesFn = (opts: {
  leadId: string;
  workspaceId: string;
}) => Promise<LeadMergeRow[]>;

export type GetLeadSummaryFn = (
  publicId: string,
  workspaceId: string,
) => Promise<{
  lead_public_id: string;
  display_name: string | null;
  display_email: string | null;
  display_phone: string | null;
  status: 'active' | 'merged' | 'erased';
  lifecycle_status: LifecycleStatus;
  first_seen_at: string;
  last_seen_at: string;
} | null>;

export type ListLeadsFn = (opts: {
  workspaceId: string;
  q?: string;
  launchPublicId?: string;
  lifecycle?: LifecycleStatus;
  cursor?: Date | null;
  limit: number;
}) => Promise<
  Array<{
    lead_public_id: string;
    display_name: string | null;
    display_email: string | null;
    display_phone: string | null;
    status: 'active' | 'merged' | 'erased';
    lifecycle_status: LifecycleStatus;
    first_seen_at: string;
    last_seen_at: string;
  }>
>;

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

const EVENT_NAME_LABELS: Record<string, string> = {
  Lead: 'Lead capturado',
  PageView: 'Visualização de página',
  Purchase: 'Compra registrada',
  InitiateCheckout: 'Checkout iniciado',
  ViewContent: 'Conteúdo visualizado',
};

function labelForEventName(eventName: string): string {
  return EVENT_NAME_LABELS[eventName] ?? eventName;
}

const SKIP_REASON_LABELS: Record<string, string> = {
  consent_denied: 'Consentimento negado',
  no_user_data: 'Sem dados do usuário',
  integration_not_configured: 'Integração não configurada',
  no_click_id_available: 'Identificador de clique indisponível',
  audience_not_eligible: 'Lead não elegível para audiência',
  archived_launch: 'Lançamento arquivado',
};

function translateSkipReason(raw: string | null): string {
  if (!raw) return 'Motivo desconhecido';
  // Handle prefix patterns like 'consent_denied:marketing'
  const base = raw.split(':')[0] ?? raw;
  return SKIP_REASON_LABELS[base] ?? raw;
}

const DESTINATION_LABELS: Record<string, string> = {
  meta_capi: 'Meta CAPI',
  ga4_mp: 'GA4 MP',
  google_ads_conversion: 'Google Ads',
  google_enhancement: 'Google (Enhanced)',
  audience_sync: 'Audience Sync',
};

function labelForDestination(destination: string): string {
  return DESTINATION_LABELS[destination] ?? destination;
}

// ---------------------------------------------------------------------------
// Payload sanitization (BR-PRIVACY-001)
// ---------------------------------------------------------------------------

/**
 * BR-PRIVACY-001: remove sensitive fields from payload for MARKETER role.
 * OPERATOR/ADMIN receive full payload.
 */
function sanitizePayload(
  payload: Record<string, unknown>,
  role: string,
): Record<string, unknown> {
  if (role === 'operator' || role === 'admin') return payload;
  // MARKETER: strip technical / debugging fields that may reveal internal details
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional destructure to strip fields
  const {
    request_body: _rb,
    response_body: _resp,
    idempotency_key: _ikey,
    response_code: _rc,
    error_code: _ec,
    ...safe
  } = payload as Record<string, unknown>;
  return safe;
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

// T-17-001: filter custom_data to a small UI-relevant set; omit the rest
const CUSTOM_DATA_ALLOWED_KEYS = new Set([
  'value',
  'currency',
  'product_name',
  'order_id',
  'transaction_id',
]);

function pickCustomData(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (CUSTOM_DATA_ALLOWED_KEYS.has(k) && v !== null && v !== undefined) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// T-17-001: subset of attribution snapshot stored on events.attribution
const ATTRIBUTION_SNAPSHOT_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid',
] as const;

function pickAttributionSnapshot(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let hasAny = false;
  for (const k of ATTRIBUTION_SNAPSHOT_KEYS) {
    const v = src[k];
    if (v !== null && v !== undefined && v !== '') {
      out[k] = v;
      hasAny = true;
    }
  }
  return hasAny ? out : undefined;
}

function buildEventNode(row: EventRow, role: string): TimelineNode {
  const ts = (row.eventTime ?? row.receivedAt).toISOString();

  // T-17-001: enrichment fields — page_name, launch_name, event_source,
  // processing_status, custom_data (filtered), attribution_snapshot (subset).
  const customData = pickCustomData(row.customData);
  const attrSnapshot = pickAttributionSnapshot(row.attribution);

  const basePayload: Record<string, unknown> = {
    event_name: row.eventName,
    event_time: ts,
    page_public_id: row.pageId ?? null,
    // BR-EVENT: event_source is canonical (tracker.js | webhook:<provider>)
    event_source: row.eventSource ?? null,
    processing_status: row.processingStatus ?? null,
    page_name: row.pageName ?? null,
    launch_name: row.launchName ?? null,
    ...(customData ? { custom_data: customData } : {}),
    ...(attrSnapshot ? { attribution_snapshot: attrSnapshot } : {}),
  };

  const fullPayload: Record<string, unknown> = {
    ...basePayload,
    // operator/admin sees the full raw attribution (not just snapshot subset)
    ...(role === 'operator' || role === 'admin'
      ? { attribution: row.attribution }
      : {}),
  };

  return {
    id: row.id,
    type: 'event_captured',
    occurred_at: ts,
    status: 'ok',
    label: labelForEventName(row.eventName),
    payload: sanitizePayload(fullPayload, role),
    skip_reason: null,
    can_replay: false,
  };
}

function buildDispatchNode(row: DispatchJobRow, role: string): TimelineNode {
  const ts = row.createdAt.toISOString();
  const destLabel = labelForDestination(row.destination);

  let label: string;
  let status: TimelineNode['status'];
  let nodeType: TimelineNode['type'];
  let detail: string | undefined;

  switch (row.status) {
    case 'succeeded':
      label = `Despachado para ${destLabel}`;
      status = 'ok';
      nodeType = 'dispatch_success';
      break;
    case 'skipped':
      label = `Não despachado: ${translateSkipReason(row.skipReason)}`;
      status = 'skipped';
      nodeType = 'dispatch_skipped';
      break;
    case 'failed':
    case 'dead_letter':
      label =
        row.nextAttemptAt
          ? 'Falhou — vai tentar novamente'
          : 'Falhou definitivamente';
      status = 'failed';
      nodeType = 'dispatch_failed';
      if (row.nextAttemptAt)
        detail = `Próxima tentativa: ${row.nextAttemptAt.toISOString()}`;
      break;
    case 'retrying':
      label = 'Falhou — vai tentar novamente';
      status = 'failed';
      nodeType = 'dispatch_failed';
      detail = row.nextAttemptAt
        ? `Próxima tentativa: ${row.nextAttemptAt.toISOString()}`
        : undefined;
      break;
    case 'pending':
    case 'processing':
    default:
      label = 'Aguardando despacho';
      status = 'pending';
      nodeType = 'dispatch_queued';
  }

  // can_replay: only for dead_letter/failed, and only for OPERATOR+
  const canReplay =
    (row.status === 'dead_letter' || row.status === 'failed') &&
    (role === 'operator' || role === 'admin');

  // T-17-002: enrichment fields — destination_resource_id, attempt_count,
  // next_attempt_at, replayed_from_dispatch_job_id (all roles); request_payload
  // gated for operator/admin (BR-PRIVACY-001).
  const basePayload: Record<string, unknown> = {
    destination: row.destination,
    status: row.status,
    event_id: row.eventId ?? null,
    destination_resource_id: row.destinationResourceId ?? null,
    attempt_count: row.attemptCount ?? 0,
    next_attempt_at: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    replayed_from_dispatch_job_id: row.replayedFromDispatchJobId ?? null,
  };

  const fullPayload: Record<string, unknown> = {
    ...basePayload,
    ...(role === 'operator' || role === 'admin'
      ? {
          response_code: row.responseStatus,
          error_code: row.errorCode,
          idempotency_key: row.idempotencyKey,
          // BR-PRIVACY-001: request_payload only for operator/admin (not marketer)
          request_payload: row.requestPayloadSanitized ?? null,
        }
      : {}),
  };

  return {
    id: row.id,
    type: nodeType,
    occurred_at: ts,
    status,
    label,
    ...(detail ? { detail } : {}),
    destination: row.destination,
    job_id: row.id,
    payload: sanitizePayload(fullPayload, role),
    skip_reason: row.skipReason ? translateSkipReason(row.skipReason) : null,
    can_replay: canReplay,
  };
}

function buildAttributionNode(row: LeadAttributionRow): TimelineNode {
  const ts = row.createdAt.toISOString();
  const isFirstTouch = row.touchType === 'first';

  // T-17-003: include touch_type, utm_content/term, click ids, ad/campaign/link ids
  return {
    id: row.id,
    type: 'attribution_set',
    occurred_at: ts,
    status: 'ok',
    label: isFirstTouch ? 'First-touch atribuído' : 'Last-touch atualizado',
    payload: {
      touch_type: row.touchType,
      utm_source: row.source,
      utm_campaign: row.campaign,
      utm_medium: row.medium,
      utm_content: row.content ?? null,
      utm_term: row.term ?? null,
      fbclid: row.fbclid ?? null,
      gclid: row.gclid ?? null,
      ad_id: row.adId ?? null,
      campaign_id: row.campaignId ?? null,
      link_id: row.linkId ?? null,
    },
    skip_reason: null,
    can_replay: false,
  };
}

function buildStageNode(row: LeadStageRow): TimelineNode {
  const ts = row.ts.toISOString();
  // T-17-003: include from_stage (LAG), source_event_id, launch_id, is_recurring.
  // funnel_role omitted: column does not exist on lead_stages (schema gap).
  return {
    id: row.id,
    type: 'stage_changed',
    occurred_at: ts,
    status: 'ok',
    label: `Stage alterado: ${row.stage}`,
    payload: {
      stage: row.stage,
      from_stage: row.fromStage ?? null,
      source_event_id: row.sourceEventId ?? null,
      launch_id: row.launchId ?? null,
      is_recurring: row.isRecurring ?? false,
    },
    skip_reason: null,
    can_replay: false,
  };
}

// T-17-004: tag_added node builder. INV-LEAD-TAG-002: set_by may be
// 'system' | 'user:<uuid>' | 'integration:<name>' | 'event:<event_name>'.
function buildTagNode(row: LeadTagRow): TimelineNode {
  const ts = row.setAt.toISOString();
  const sourceEventName = row.setBy.startsWith('event:')
    ? row.setBy.slice('event:'.length)
    : null;

  return {
    id: row.id,
    type: 'tag_added',
    occurred_at: ts,
    status: 'ok',
    label: `Tag aplicada: ${row.tagName}`,
    payload: {
      tag_name: row.tagName,
      set_by: row.setBy,
      source_event_name: sourceEventName,
    },
    skip_reason: null,
    can_replay: false,
  };
}

// T-17-004: consent_updated node builder. Computes purposes_diff between this
// row and the previous one (when provided). When prev is null, exposes the full
// snapshot as the diff (i.e., "first known state").
const CONSENT_FIELDS: Array<{
  key: 'analytics' | 'marketing' | 'ad_user_data' | 'ad_personalization' | 'customer_match';
  col: keyof Pick<
    LeadConsentRow,
    | 'consentAnalytics'
    | 'consentMarketing'
    | 'consentAdUserData'
    | 'consentAdPersonalization'
    | 'consentCustomerMatch'
  >;
}> = [
  { key: 'analytics', col: 'consentAnalytics' },
  { key: 'marketing', col: 'consentMarketing' },
  { key: 'ad_user_data', col: 'consentAdUserData' },
  { key: 'ad_personalization', col: 'consentAdPersonalization' },
  { key: 'customer_match', col: 'consentCustomerMatch' },
];

function buildConsentNode(row: LeadConsentRow): TimelineNode {
  const ts = row.ts.toISOString();
  const diff: Record<string, string> = {};

  for (const f of CONSENT_FIELDS) {
    const curr = row[f.col] as string;
    const prev = row.prev ? (row.prev[f.col] as string) : null;
    if (prev === null || curr !== prev) {
      diff[f.key] = curr;
    }
  }

  return {
    id: row.id,
    type: 'consent_updated',
    occurred_at: ts,
    status: 'ok',
    label: 'Consentimento atualizado',
    payload: {
      purposes_diff: diff,
      source: row.source,
      policy_version: row.policyVersion,
    },
    skip_reason: null,
    can_replay: false,
  };
}

// T-17-004: merge node builder. BR-IDENTITY-013: expose lead_public_id,
// never internal lead_id.
function buildMergeNode(row: LeadMergeRow): TimelineNode {
  const ts = row.mergedAt.toISOString();
  return {
    id: row.id,
    type: 'merge',
    occurred_at: ts,
    status: 'ok',
    label: 'Lead mesclado',
    payload: {
      primary_lead_public_id: row.primaryLeadPublicId,
      merged_lead_public_id: row.mergedLeadPublicId,
      reason: row.reason,
      before_summary: row.beforeSummary ?? null,
      after_summary: row.afterSummary ?? null,
      performed_by: row.performedBy,
    },
    skip_reason: null,
    can_replay: false,
  };
}

// ---------------------------------------------------------------------------
// Merge and sort helper
// ---------------------------------------------------------------------------

/**
 * Merge all node arrays, sort descending by timestamp (most recent first),
 * apply limit, and compute next_cursor.
 */
function mergeAndSort(
  allNodes: TimelineNode[],
  limit: number,
): { nodes: TimelineNode[]; next_cursor: string | null } {
  allNodes.sort((a, b) => {
    // Descending — more recent first
    return new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
  });

  const sliced = allNodes.slice(0, limit);
  const last = sliced[sliced.length - 1];
  const next_cursor = allNodes.length > limit && last ? last.occurred_at : null;

  return { nodes: sliced, next_cursor };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createLeadsTimelineRoute(opts?: {
  getConnStr?: (env: AppBindings) => string;
  getMasterKey?: (env: AppBindings) => string;
  // legacy injected deps (for tests)
  getLeadByPublicId?: GetLeadByPublicIdFn;
  getEvents?: GetEventsFn;
  getDispatchJobs?: GetDispatchJobsFn;
  getLeadAttributions?: GetLeadAttributionsFn;
  getLeadStages?: GetLeadStagesFn;
  // T-17-004: optional new node sources (graceful fallback when not wired)
  getLeadTags?: GetLeadTagsFn;
  getLeadConsents?: GetLeadConsentsFn;
  getLeadMerges?: GetLeadMergesFn;
  getLeadSummary?: GetLeadSummaryFn;
  listLeads?: ListLeadsFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  function resolveQueryFns(env: AppBindings) {
    if (opts?.getConnStr) {
      const connStr = opts.getConnStr(env);
      const masterKey = opts.getMasterKey ? opts.getMasterKey(env) : '';
      const registry: Record<number, string> = masterKey
        ? { 1: masterKey }
        : {};
      return createLeadsQueryFns(connStr, registry);
    }
    // legacy injected deps (tests / no-op default)
    return {
      getLeadByPublicId: opts?.getLeadByPublicId,
      getLeadSummary: opts?.getLeadSummary,
      getEvents: opts?.getEvents,
      getDispatchJobs: opts?.getDispatchJobs,
      getLeadAttributions: opts?.getLeadAttributions,
      getLeadStages: opts?.getLeadStages,
      getLeadTags: opts?.getLeadTags,
      getLeadConsents: opts?.getLeadConsents,
      getLeadMerges: opts?.getLeadMerges,
      listLeads: opts?.listLeads,
    };
  }

  // ---------------------------------------------------------------------------
  // Auth middleware — verifies Supabase JWT and resolves workspace_member
  // ---------------------------------------------------------------------------
  const buildLookupMember = (env: AppBindings): LookupWorkspaceMemberFn => {
    return async (userId: string) => {
      const connStr = opts?.getConnStr
        ? opts.getConnStr(env)
        : (env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '');
      if (!connStr) return null;
      const db = createDb(connStr);
      const rows = await db
        .select({
          workspace_id: workspaceMembers.workspaceId,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .limit(1);
      const row = rows[0];
      if (!row || !isValidRole(row.role)) return null;
      return { workspace_id: row.workspace_id, role: row.role };
    };
  };

  // Middleware applied to all /v1/leads routes. Required mode: requires JWT
  // unless DEV_WORKSPACE_ID is configured, in which case it falls back.
  route.use('*', async (c, next) => {
    const mw = supabaseJwtMiddleware<AppEnv>({
      lookupMember: buildLookupMember(c.env),
    });
    return mw(c, next);
  });

  // -------------------------------------------------------------------------
  // GET / — list leads (paginated, optional search + launch filter)
  // -------------------------------------------------------------------------
  route.get('/', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }

    const role = (c.get('role') as WorkspaceRole | undefined) ?? null;
    const seePlain = canSeePiiPlainByDefault(role);

    const rawQuery = c.req.query();
    const listParseResult = ListLeadsQuerySchema.safeParse({
      q: rawQuery.q,
      launch_public_id: rawQuery.launch_public_id,
      cursor: rawQuery.cursor,
      limit: rawQuery.limit,
      lifecycle: rawQuery.lifecycle,
      sort_by: rawQuery.sort_by,
      sort_dir: rawQuery.sort_dir,
    });
    if (!listParseResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid query parameters',
          details: listParseResult.error.flatten().fieldErrors,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const q = listParseResult.data.q?.trim() || undefined;
    const launchPublicId = listParseResult.data.launch_public_id?.trim() || undefined;
    const lifecycle = listParseResult.data.lifecycle;
    const sortBy = listParseResult.data.sort_by ?? 'last_seen_at';
    const sortDir = listParseResult.data.sort_dir ?? 'desc';
    const rawLimit = Math.min(
      Math.max(1, Number(listParseResult.data.limit ?? 30)),
      100,
    );
    const cursorRaw = listParseResult.data.cursor;
    const cursor = cursorRaw ? new Date(cursorRaw) : null;

    const qfns = resolveQueryFns(c.env);

    if (!qfns.listLeads) {
      return c.json({ items: [], next_cursor: null }, 200, {
        'X-Request-Id': requestId,
      });
    }

    const items = await qfns.listLeads({
      workspaceId,
      q,
      launchPublicId,
      lifecycle,
      cursor,
      limit: rawLimit + 1,
      sortBy,
      sortDir,
    });

    const hasMore = items.length > rawLimit;
    const page = hasMore ? items.slice(0, rawLimit) : items;
    const lastItem = page.length > 0 ? page[page.length - 1]! : null;
    // Cursor is only supported for date-based sorts (keyset pagination).
    const nextCursor =
      hasMore && lastItem && (sortBy === 'last_seen_at' || sortBy === 'first_seen_at')
        ? (sortBy === 'first_seen_at' ? lastItem.first_seen_at : lastItem.last_seen_at)
        : null;

    // ADR-034 / BR-IDENTITY-006: mask email/phone for operator/viewer.
    const masked = seePlain
      ? page
      : page.map((lead) => ({
          ...lead,
          display_email: maskEmail(lead.display_email),
          display_phone: maskPhone(lead.display_phone),
        }));

    return c.json(
      { items: masked, next_cursor: nextCursor, role, pii_masked: !seePlain },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // GET /:public_id — lead summary (display_name, status, timestamps)
  // -------------------------------------------------------------------------
  route.get('/:public_id', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }

    const role = (c.get('role') as WorkspaceRole | undefined) ?? null;
    const seePlain = canSeePiiPlainByDefault(role);
    const publicId = c.req.param('public_id');

    const qfnsSummary = resolveQueryFns(c.env);

    if (!qfnsSummary.getLeadSummary) {
      return c.json(
        { code: 'not_found', request_id: requestId },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    const summary = await qfnsSummary.getLeadSummary(publicId, workspaceId);
    if (!summary) {
      return c.json(
        { code: 'lead_not_found', request_id: requestId },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    const masked = seePlain
      ? summary
      : {
          ...summary,
          display_email: maskEmail(summary.display_email),
          display_phone: maskPhone(summary.display_phone),
        };

    return c.json(
      { ...masked, role, pii_masked: !seePlain },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // GET /:public_id/timeline
  // CONTRACT-api-leads-timeline-v1
  // -------------------------------------------------------------------------
  route.get('/:public_id/timeline', async (c) => {
    // request_id is set by sanitize-logs middleware; fall back if invoked in isolation
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // -----------------------------------------------------------------------
    // 1. Auth — require non-empty Authorization: Bearer header
    //    (Sprint 6 simplified auth — full JWT scope enforcement in Sprint 6 RBAC pass)
    // -----------------------------------------------------------------------
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // BR-PRIVACY-001: no PII in response
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }

    // -----------------------------------------------------------------------
    // 2. Extract role from context (set by auth middleware)
    //    TODO Sprint 6 RBAC: extract role from JWT claims
    //    Fallback to 'marketer' (most restrictive) — BR-PRIVACY-001
    // -----------------------------------------------------------------------
    // BR-PRIVACY-001: fallback to most restrictive role when role is unknown
    const role = (c.get('role') as string | undefined) ?? 'marketer';

    // -----------------------------------------------------------------------
    // 3. Validate path param
    // -----------------------------------------------------------------------
    const publicId = c.req.param('public_id');
    if (!publicId || publicId.trim() === '') {
      return c.json(
        {
          code: 'validation_error',
          message: 'public_id is required',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 4. Validate query params
    // -----------------------------------------------------------------------
    const rawQuery = c.req.query();
    const queryParseResult = TimelineQuerySchema.safeParse({
      cursor: rawQuery.cursor,
      limit: rawQuery.limit,
      filters: rawQuery.filters,
    });

    if (!queryParseResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid query parameters',
          details: queryParseResult.error.flatten().fieldErrors,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const { cursor, limit, filters: filtersRaw, since: sinceRaw } = queryParseResult.data;
    const sinceDate = sinceRaw ? new Date(sinceRaw) : null;

    // Parse optional filters JSON
    let parsedFilters: { types?: string[]; statuses?: string[] } | null = null;
    if (filtersRaw) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- filter is JSON from query
        parsedFilters = JSON.parse(filtersRaw);
      } catch {
        return c.json(
          {
            code: 'validation_error',
            message: 'filters must be a valid JSON string',
            request_id: requestId,
          },
          400,
          { 'X-Request-Id': requestId },
        );
      }
    }

    // Build cursor Date for DB queries
    const cursorDate = cursor ? new Date(cursor) : null;
    if (cursor && cursorDate && Number.isNaN(cursorDate.getTime())) {
      return c.json(
        {
          code: 'validation_error',
          message: 'cursor must be a valid ISO 8601 timestamp',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 5. Resolve lead_id from public_id
    //    BR-IDENTITY-013: browser uses public_id, never internal lead_id
    // -----------------------------------------------------------------------

    // workspace_id — if available from auth middleware context
    const workspaceId =
      (c.get('workspace_id') as string | undefined) ??
      c.env.DEV_WORKSPACE_ID ??
      '';

    const timelineFns = resolveQueryFns(c.env);

    if (timelineFns.getLeadByPublicId) {
      let lookupResult: LeadLookupResult;
      try {
        lookupResult = await timelineFns.getLeadByPublicId(publicId, workspaceId);
      } catch (err) {
        // BR-PRIVACY-001: no PII in log — public_id is opaque
        safeLog('error', {
          event: 'leads_timeline_db_error',
          request_id: requestId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        return c.json({ code: 'internal_error', request_id: requestId }, 500, {
          'X-Request-Id': requestId,
        });
      }

      if (!lookupResult.found) {
        return c.json({ code: 'lead_not_found', request_id: requestId }, 404, {
          'X-Request-Id': requestId,
        });
      }

      const leadId = lookupResult.leadId;

      // -------------------------------------------------------------------
      // 6. Fetch node sources in parallel
      // -------------------------------------------------------------------
      let eventRows: EventRow[] = [];
      let dispatchRows: DispatchJobRow[] = [];
      let attributionRows: LeadAttributionRow[] = [];
      let stageRows: LeadStageRow[] = [];
      // T-17-004: new node sources
      let tagRows: LeadTagRow[] = [];
      let consentRows: LeadConsentRow[] = [];
      let mergeRows: LeadMergeRow[] = [];

      try {
        [
          eventRows,
          dispatchRows,
          attributionRows,
          stageRows,
          tagRows,
          consentRows,
          mergeRows,
        ] = await Promise.all([
          timelineFns.getEvents
            ? timelineFns.getEvents({
                leadId,
                workspaceId,
                cursor: cursorDate,
                limit,
              })
            : Promise.resolve([]),
          timelineFns.getDispatchJobs
            ? timelineFns.getDispatchJobs({
                leadId,
                workspaceId,
                cursor: cursorDate,
                limit,
              })
            : Promise.resolve([]),
          timelineFns.getLeadAttributions
            ? timelineFns.getLeadAttributions({ leadId, workspaceId })
            : Promise.resolve([]),
          timelineFns.getLeadStages
            ? timelineFns.getLeadStages({ leadId, workspaceId })
            : Promise.resolve([]),
          timelineFns.getLeadTags
            ? timelineFns.getLeadTags({ leadId, workspaceId })
            : Promise.resolve([] as LeadTagRow[]),
          timelineFns.getLeadConsents
            ? timelineFns.getLeadConsents({ leadId, workspaceId })
            : Promise.resolve([] as LeadConsentRow[]),
          timelineFns.getLeadMerges
            ? timelineFns.getLeadMerges({ leadId, workspaceId })
            : Promise.resolve([] as LeadMergeRow[]),
        ]);
      } catch (err) {
        safeLog('error', {
          event: 'leads_timeline_fetch_error',
          request_id: requestId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        return c.json({ code: 'internal_error', request_id: requestId }, 500, {
          'X-Request-Id': requestId,
        });
      }

      // -------------------------------------------------------------------
      // 7. Build nodes from each source
      // -------------------------------------------------------------------
      // T-17-005: merge all node sources into a single chronologically sorted timeline.
      const allNodes: TimelineNode[] = [
        ...eventRows.map((r) => buildEventNode(r, role)),
        ...dispatchRows.map((r) => buildDispatchNode(r, role)),
        ...attributionRows.map((r) => buildAttributionNode(r)),
        ...stageRows.map((r) => buildStageNode(r)),
        // T-17-004: tag_added | consent_updated | merge
        ...tagRows.map((r) => buildTagNode(r)),
        ...consentRows.map((r) => buildConsentNode(r)),
        ...mergeRows.map((r) => buildMergeNode(r)),
        // TODO Sprint 7: adicionar SAR/erasure nodes a partir de audit_log
      ];

      // -------------------------------------------------------------------
      // 8. Apply type/status filters if provided
      // -------------------------------------------------------------------
      let filteredNodes = allNodes;
      if (parsedFilters) {
        if (parsedFilters.types && parsedFilters.types.length > 0) {
          const allowedTypes = new Set(parsedFilters.types);
          filteredNodes = filteredNodes.filter((n) => allowedTypes.has(n.type));
        }
        if (parsedFilters.statuses && parsedFilters.statuses.length > 0) {
          const allowedStatuses = new Set(parsedFilters.statuses);
          filteredNodes = filteredNodes.filter((n) =>
            allowedStatuses.has(n.status),
          );
        }
      }
      if (sinceDate && !Number.isNaN(sinceDate.getTime())) {
        filteredNodes = filteredNodes.filter(
          (n) => new Date(n.occurred_at) >= sinceDate,
        );
      }

      // -------------------------------------------------------------------
      // 9. Merge, sort descending, paginate
      // -------------------------------------------------------------------
      const totalCount = filteredNodes.length;
      const { nodes, next_cursor } = mergeAndSort(filteredNodes, limit);

      const response: TimelineResponse = {
        lead_public_id: publicId,
        nodes,
        next_cursor,
        total_count: totalCount,
      };

      return c.json(response, 200, { 'X-Request-Id': requestId });
    }

    // -----------------------------------------------------------------------
    // No DB deps injected — return empty timeline (stub mode)
    // -----------------------------------------------------------------------
    safeLog('warn', {
      event: 'leads_timeline_no_db_deps',
      request_id: requestId,
    });

    const response: TimelineResponse = {
      lead_public_id: publicId,
      nodes: [],
      next_cursor: null,
      total_count: 0,
    };

    return c.json(response, 200, { 'X-Request-Id': requestId });
  });

  // -------------------------------------------------------------------------
  // POST /:public_id/reveal-pii — operator+ reveals masked PII with audit
  // ADR-034 / BR-IDENTITY-006
  // -------------------------------------------------------------------------
  const RevealBodySchema = z.object({
    reason: z.string().min(3).max(500),
  });

  route.post('/:public_id/reveal-pii', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    const workspaceId = c.get('workspace_id') as string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = (c as any).get('user_id') as string | undefined;
    const role = (c.get('role') as WorkspaceRole | undefined) ?? null;

    if (!workspaceId || !userId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }

    if (!canRevealPii(role)) {
      // Even denied attempts are audited (AUTHZ-001 spec).
      const connStr = opts?.getConnStr
        ? opts.getConnStr(c.env)
        : (c.env.DATABASE_URL ?? c.env.HYPERDRIVE?.connectionString ?? '');
      if (connStr) {
        try {
          const db = createDb(connStr);
          await db.insert(auditLog).values({
            workspaceId,
            actorId: userId,
            actorType: 'user',
            action: 'read_pii_decrypted_denied',
            entityType: 'lead',
            entityId: c.req.param('public_id'),
            after: { role, request_id: requestId },
            requestContext: { request_id: requestId },
          });
        } catch {
          /* best-effort */
        }
      }
      return c.json({ code: 'forbidden_role', role }, 403, {
        'X-Request-Id': requestId,
      });
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = RevealBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ code: 'invalid_body', issues: parsed.error.issues }, 400, {
        'X-Request-Id': requestId,
      });
    }

    const publicId = c.req.param('public_id');

    const qfns = resolveQueryFns(c.env);
    if (!qfns.getLeadSummary) {
      return c.json({ code: 'unavailable' }, 503, {
        'X-Request-Id': requestId,
      });
    }

    const summary = await qfns.getLeadSummary(publicId, workspaceId);
    if (!summary) {
      return c.json({ code: 'not_found' }, 404, {
        'X-Request-Id': requestId,
      });
    }

    // Audit BEFORE returning the plaintext.
    const connStr = opts?.getConnStr
      ? opts.getConnStr(c.env)
      : (c.env.DATABASE_URL ?? c.env.HYPERDRIVE?.connectionString ?? '');
    if (connStr) {
      try {
        const db = createDb(connStr);
        await db.insert(auditLog).values({
          workspaceId,
          actorId: userId,
          actorType: 'user',
          action: 'read_pii_decrypted',
          entityType: 'lead',
          entityId: publicId,
          after: {
            role,
            fields_accessed: ['email', 'phone'],
            reason: parsed.data.reason,
            request_id: requestId,
          },
          requestContext: { request_id: requestId },
        });
      } catch (err) {
        safeLog('error', {
          event: 'audit_log_failed',
          request_id: requestId,
          error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        });
      }
    }

    return c.json(
      {
        lead_public_id: summary.lead_public_id,
        display_email: summary.display_email,
        display_phone: summary.display_phone,
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance with no-op stubs.
// Callers should prefer createLeadsTimelineRoute(deps) to wire real DB.
// ---------------------------------------------------------------------------

/**
 * Default leadsTimelineRoute instance — all DB lookups return empty/stub values.
 *
 * Wire real dependencies in index.ts via:
 * ```ts
 * app.route('/v1/leads', createLeadsTimelineRoute({ getLeadByPublicId, getEvents, ... }));
 * ```
 */
export const leadsTimelineRoute = createLeadsTimelineRoute();
