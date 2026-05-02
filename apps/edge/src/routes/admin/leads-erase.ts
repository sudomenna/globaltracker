/**
 * routes/admin/leads-erase.ts — DELETE /v1/admin/leads/:lead_id
 *
 * SAR/erasure endpoint. Enqueues an anonymisation job for the lead identified
 * by `lead_id` (internal UUID). Does NOT perform the erasure synchronously —
 * it follows the "fast accept" model: validate → enqueue → audit → 202.
 *
 * CONTRACT-api-admin-leads-erase-v1
 *
 * Auth (Sprint 1 simplified — real API-key scope enforcement in Sprint 6):
 *   Requires `Authorization: Bearer <api_key>` header (non-empty).
 *   Missing / empty → 401.
 *
 * Double-confirm (BR-RBAC-005):
 *   Requires `X-Confirm-Erase: true` header.
 *   Missing / not exactly "true" → 403.
 *
 * Idempotency (BR-PRIVACY-003):
 *   If DB is available and the lead status is already "erased" → 409.
 *   If lead not found in DB → 404.
 *   If DB unavailable → optimistic accept (enqueue + audit + 202).
 *
 * BR-AUDIT-001: every admin mutation generates an audit log entry.
 * BR-PRIVACY-001: zero PII in logs and error responses — lead_id is an opaque
 *   UUID; email/phone/name never appear in logs or responses here.
 * BR-PRIVACY-003: erasure endpoint is idempotent per FLOW-09 A1.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { safeLog } from '../../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env types (mirrors apps/edge/src/index.ts)
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  /** Hyperdrive binding — undefined until configured in production. */
  DB?: Fetcher;
};

type AppVariables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Validates that :lead_id path param is a well-formed UUID. */
const LeadIdParamSchema = z.object({
  lead_id: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// DB lookup function type (injected — no direct DB coupling in route)
// ---------------------------------------------------------------------------

/**
 * Result of querying lead status by internal UUID.
 * domain-author wires this up via apps/edge/src/lib/lead.ts → getLeadStatus().
 */
export type LeadStatusResult =
  | { found: false }
  | { found: true; status: 'active' | 'merged' | 'erased' };

export type GetLeadStatusFn = (leadId: string) => Promise<LeadStatusResult>;

/**
 * Audit entry insertion function injected by the caller.
 * domain-author wires this up via apps/edge/src/lib/audit.ts → recordAuditEntry().
 *
 * In Sprint 1, if DB is unavailable, the route logs a [AUDIT-PENDING] warning
 * and continues (optimistic accept pattern from FLOW-09).
 *
 * BR-AUDIT-001: every operation here MUST generate an audit entry.
 */
export type InsertAuditEntryFn = (entry: {
  action: string;
  actor_type: string;
  actor_id: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  request_id: string;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create the admin leads-erase sub-router with injected dependencies.
 *
 * Usage in index.ts (wired by orchestrator):
 * ```ts
 * import { createAdminLeadsEraseRoute } from './routes/admin/leads-erase.js';
 * app.route('/v1/admin/leads', createAdminLeadsEraseRoute({ getLeadStatus, insertAuditEntry }));
 * ```
 *
 * @param deps.getLeadStatus - async function that queries lead status by lead_id.
 * @param deps.insertAuditEntry - async function that inserts an audit log entry.
 */
export function createAdminLeadsEraseRoute(deps?: {
  getLeadStatus?: GetLeadStatusFn;
  insertAuditEntry?: InsertAuditEntryFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // DELETE /:lead_id
  // CONTRACT-api-admin-leads-erase-v1
  // -------------------------------------------------------------------------
  route.delete('/:lead_id', async (c) => {
    // request_id is set by sanitize-logs middleware (global). If for any reason
    // the route is invoked without the middleware (e.g. in isolated unit tests),
    // fall back to a generated UUID so X-Request-Id is always present.
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // -----------------------------------------------------------------------
    // 1. Auth — require non-empty Authorization: Bearer header
    //    (Sprint 1 simplified auth — scope enforcement in Sprint 6)
    // -----------------------------------------------------------------------
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      // BR-PRIVACY-001: no PII in response
      return c.json({ error: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }

    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!bearerMatch || !bearerMatch[1]?.trim()) {
      return c.json({ error: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }

    // Extract actor identifier from the Bearer token for audit log.
    // BR-PRIVACY-001: we store the raw token value here only as actor_id in the
    // audit log (opaque reference). No PII at all in this flow.
    const apiKeyRaw = bearerMatch[1].trim();

    // -----------------------------------------------------------------------
    // 2. Double-confirm — require X-Confirm-Erase: true
    //    BR-RBAC-005: protects against accidental/scripted erasure calls.
    //    FLOW-09 §5: header must be present and exactly "true".
    // -----------------------------------------------------------------------
    const confirmHeader = c.req.header('X-Confirm-Erase');

    if (confirmHeader !== 'true') {
      return c.json(
        {
          error: 'missing_confirm_erase_header',
          message: 'Send X-Confirm-Erase: true to confirm',
          request_id: requestId,
        },
        403,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 3. Validate :lead_id path param as UUID
    // -----------------------------------------------------------------------
    const parseResult = LeadIdParamSchema.safeParse({
      lead_id: c.req.param('lead_id'),
    });

    if (!parseResult.success) {
      return c.json(
        {
          error: 'validation_error',
          message: 'lead_id must be a valid UUID',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const leadId = parseResult.data.lead_id;

    // -----------------------------------------------------------------------
    // 4. DB lookup — check lead existence and current status (if DB available)
    //    BR-PRIVACY-003: idempotency — already-erased returns 409.
    //    FLOW-09 A1: 409 only from Edge for already_erased; the worker handles
    //    races internally.
    // -----------------------------------------------------------------------
    if (deps?.getLeadStatus && c.env.DB) {
      let leadStatus: LeadStatusResult;

      try {
        leadStatus = await deps.getLeadStatus(leadId);
      } catch (err) {
        // DB error — log without PII and fail safely
        // BR-PRIVACY-001: no PII in log — lead_id is opaque UUID
        safeLog('error', {
          event: 'admin_leads_erase_db_error',
          request_id: requestId,
          lead_id: leadId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });

        return c.json({ error: 'internal_error', request_id: requestId }, 500, {
          'X-Request-Id': requestId,
        });
      }

      if (!leadStatus.found) {
        return c.json({ error: 'lead_not_found', request_id: requestId }, 404, {
          'X-Request-Id': requestId,
        });
      }

      // BR-PRIVACY-003: idempotency — already-erased leads return 409
      if (leadStatus.status === 'erased') {
        return c.json({ error: 'already_erased', request_id: requestId }, 409, {
          'X-Request-Id': requestId,
        });
      }
    }

    // -----------------------------------------------------------------------
    // 5. Generate job_id
    // -----------------------------------------------------------------------
    const jobId = crypto.randomUUID();

    // -----------------------------------------------------------------------
    // 6. Enqueue erasure job in QUEUE_DISPATCH
    //    worker consumes and performs actual anonymisation (FLOW-09 §7-9)
    // -----------------------------------------------------------------------
    try {
      await c.env.QUEUE_DISPATCH.send({
        type: 'lead_erase',
        lead_id: leadId,
        job_id: jobId,
        requested_at: new Date().toISOString(),
        request_id: requestId,
      });
    } catch (err) {
      // Queue send failure — cannot accept the request
      safeLog('error', {
        event: 'admin_leads_erase_queue_error',
        request_id: requestId,
        job_id: jobId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });

      return c.json({ error: 'internal_error', request_id: requestId }, 500, {
        'X-Request-Id': requestId,
      });
    }

    // -----------------------------------------------------------------------
    // 7. Audit log
    //    BR-AUDIT-001: every admin operation must generate an audit entry.
    //    If DB/audit helper unavailable: log [AUDIT-PENDING] warning (optimistic
    //    accept — the erasure worker will record erase_sar_completed).
    //    BR-PRIVACY-001: lead_id is opaque UUID — no PII in metadata.
    // -----------------------------------------------------------------------
    if (deps?.insertAuditEntry) {
      try {
        await deps.insertAuditEntry({
          action: 'lead_erase_queued',
          actor_type: 'api_key',
          actor_id: apiKeyRaw,
          entity_type: 'lead',
          entity_id: leadId,
          metadata: { job_id: jobId, request_id: requestId },
          request_id: requestId,
        });
      } catch (err) {
        // BR-AUDIT-001: log warning but do not fail the request — the erasure
        // worker records its own audit entry on completion (erase_sar_completed).
        // BR-PRIVACY-001: no PII in log; lead_id is opaque UUID.
        safeLog('warn', {
          event: '[AUDIT-PENDING] lead_erase_queued',
          request_id: requestId,
          lead_id: leadId,
          job_id: jobId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    } else {
      // DB unavailable — log pending audit
      // BR-PRIVACY-001: lead_id is opaque UUID, no PII here
      safeLog('warn', {
        event: '[AUDIT-PENDING] lead_erase_queued',
        request_id: requestId,
        lead_id: leadId,
        job_id: jobId,
      });
    }

    // -----------------------------------------------------------------------
    // 8. Return 202 Accepted
    //    CONTRACT-api-admin-leads-erase-v1 response shape
    // -----------------------------------------------------------------------
    return c.json({ job_id: jobId, status: 'queued' }, 202, {
      'X-Request-Id': requestId,
    });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance with no-op stubs.
// Callers should prefer createAdminLeadsEraseRoute(deps) to wire real DB.
// ---------------------------------------------------------------------------

/**
 * Default adminLeadsEraseRoute instance — DB lookups return stub values.
 *
 * Wire real dependencies in index.ts via:
 * ```ts
 * app.route('/v1/admin/leads', createAdminLeadsEraseRoute({ getLeadStatus, insertAuditEntry }));
 * ```
 */
export const adminLeadsEraseRoute = createAdminLeadsEraseRoute();
