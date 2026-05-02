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
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env / context types
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
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

const TimelineQuerySchema = z
  .object({
    cursor: z.string().optional(), // ISO timestamp — only nodes before this are returned
    limit: z.coerce.number().min(1).max(50).default(50),
    filters: z.string().optional(), // JSON string: { types?: string[], statuses?: string[] }
  })
  .strict();

// ---------------------------------------------------------------------------
// TimelineNode type
// ---------------------------------------------------------------------------

export type TimelineNodeStatus =
  | 'success'
  | 'warning'
  | 'error'
  | 'pending'
  | 'unknown';

export type TimelineNodeType =
  | 'event'
  | 'identity'
  | 'attribution'
  | 'stage'
  | 'consent'
  | 'dispatch'
  | 'sar';

export type TimelineNode = {
  id: string;
  type: TimelineNodeType;
  timestamp: string;
  status: TimelineNodeStatus;
  label: string;
  detail?: string;
  destination?: string;
  job_id?: string;
  payload?: Record<string, unknown>;
  can_replay?: boolean;
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
};

type DispatchJobRow = {
  id: string;
  destination: string;
  status: string;
  skipReason: string | null;
  idempotencyKey: string;
  nextAttemptAt: Date | null;
  createdAt: Date;
  // Joined from dispatch_attempts (latest attempt)
  responseStatus: number | null;
  errorCode: string | null;
};

type LeadAttributionRow = {
  id: string;
  touchType: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  createdAt: Date;
};

type LeadStageRow = {
  id: string;
  stage: string;
  ts: Date;
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

function buildEventNode(row: EventRow, role: string): TimelineNode {
  const ts = (row.eventTime ?? row.receivedAt).toISOString();

  const basePayload: Record<string, unknown> = {
    event_name: row.eventName,
    event_time: ts,
    page_public_id: row.pageId ?? null,
  };

  const fullPayload: Record<string, unknown> = {
    ...basePayload,
    ...(role === 'operator' || role === 'admin'
      ? { attribution: row.attribution }
      : {}),
  };

  return {
    id: row.id,
    type: 'event',
    timestamp: ts,
    status: 'success',
    label: labelForEventName(row.eventName),
    payload: sanitizePayload(fullPayload, role),
  };
}

function buildDispatchNode(row: DispatchJobRow, role: string): TimelineNode {
  const ts = row.createdAt.toISOString();
  const destLabel = labelForDestination(row.destination);

  let label: string;
  let status: TimelineNodeStatus;
  let detail: string | undefined;

  switch (row.status) {
    case 'succeeded':
      label = `Despachado para ${destLabel}`;
      status = 'success';
      break;
    case 'skipped':
      label = `Não despachado: ${translateSkipReason(row.skipReason)}`;
      status = 'warning';
      break;
    case 'failed':
      if (row.nextAttemptAt) {
        label = 'Falhou — vai tentar novamente';
        status = 'warning';
        detail = `Próxima tentativa: ${row.nextAttemptAt.toISOString()}`;
      } else {
        label = 'Falhou definitivamente';
        status = 'error';
      }
      break;
    case 'dead_letter':
      label = 'Falhou e parou de tentar';
      status = 'error';
      break;
    case 'pending':
    case 'processing':
      label = 'Aguardando despacho';
      status = 'pending';
      break;
    case 'retrying':
      label = 'Falhou — vai tentar novamente';
      status = 'warning';
      detail = row.nextAttemptAt
        ? `Próxima tentativa: ${row.nextAttemptAt.toISOString()}`
        : undefined;
      break;
    default:
      label = `Status: ${row.status}`;
      status = 'unknown';
  }

  // can_replay: only for dead_letter/failed, and only for OPERATOR+
  // BR-PRIVACY-001: MARKETER never gets can_replay=true
  const canReplay =
    (row.status === 'dead_letter' || row.status === 'failed') &&
    (role === 'operator' || role === 'admin');

  const basePayload: Record<string, unknown> = {
    destination: row.destination,
    status: row.status,
    skip_reason: translateSkipReason(row.skipReason),
  };

  const fullPayload: Record<string, unknown> = {
    ...basePayload,
    ...(role === 'operator' || role === 'admin'
      ? {
          response_code: row.responseStatus,
          error_code: row.errorCode,
          idempotency_key: row.idempotencyKey,
        }
      : {}),
  };

  return {
    id: row.id,
    type: 'dispatch',
    timestamp: ts,
    status,
    label,
    ...(detail ? { detail } : {}),
    destination: row.destination,
    job_id: row.id,
    payload: sanitizePayload(fullPayload, role),
    can_replay: canReplay,
  };
}

function buildAttributionNode(row: LeadAttributionRow): TimelineNode {
  const ts = row.createdAt.toISOString();
  // BR-ATTRIBUTION-001/002: first-touch vs last-touch
  const isFirstTouch = row.touchType === 'first';

  return {
    id: row.id,
    type: 'attribution',
    timestamp: ts,
    status: 'success',
    label: isFirstTouch ? 'First-touch atribuído' : 'Last-touch atualizado',
    payload: {
      // UTM fields are not PII — safe to expose to all roles
      utm_source: row.source,
      utm_campaign: row.campaign,
      utm_medium: row.medium,
    },
  };
}

function buildStageNode(row: LeadStageRow): TimelineNode {
  const ts = row.ts.toISOString();
  return {
    id: row.id,
    type: 'stage',
    timestamp: ts,
    status: 'success',
    label: `Stage alterado: ${row.stage}`,
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
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  const sliced = allNodes.slice(0, limit);
  const last = sliced[sliced.length - 1];
  const next_cursor = allNodes.length > limit && last ? last.timestamp : null;

  return { nodes: sliced, next_cursor };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createLeadsTimelineRoute(deps?: {
  getLeadByPublicId?: GetLeadByPublicIdFn;
  getEvents?: GetEventsFn;
  getDispatchJobs?: GetDispatchJobsFn;
  getLeadAttributions?: GetLeadAttributionsFn;
  getLeadStages?: GetLeadStagesFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

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

    const { cursor, limit, filters: filtersRaw } = queryParseResult.data;

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
    const workspaceId = (c.get('workspace_id') as string | undefined) ?? '';

    if (deps?.getLeadByPublicId) {
      let lookupResult: LeadLookupResult;
      try {
        lookupResult = await deps.getLeadByPublicId(publicId, workspaceId);
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

      try {
        [eventRows, dispatchRows, attributionRows, stageRows] =
          await Promise.all([
            deps.getEvents
              ? deps.getEvents({
                  leadId,
                  workspaceId,
                  cursor: cursorDate,
                  limit,
                })
              : Promise.resolve([]),
            deps.getDispatchJobs
              ? deps.getDispatchJobs({
                  leadId,
                  workspaceId,
                  cursor: cursorDate,
                  limit,
                })
              : Promise.resolve([]),
            deps.getLeadAttributions
              ? deps.getLeadAttributions({ leadId, workspaceId })
              : Promise.resolve([]),
            deps.getLeadStages
              ? deps.getLeadStages({ leadId, workspaceId })
              : Promise.resolve([]),
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
      const allNodes: TimelineNode[] = [
        ...eventRows.map((r) => buildEventNode(r, role)),
        ...dispatchRows.map((r) => buildDispatchNode(r, role)),
        ...attributionRows.map((r) => buildAttributionNode(r)),
        ...stageRows.map((r) => buildStageNode(r)),
        // TODO T-6-010: adicionar consent nodes a partir de lead_consents
        // TODO T-6-010: adicionar SAR/erasure nodes a partir de audit_log (Sprint 7)
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
