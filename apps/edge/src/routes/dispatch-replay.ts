/**
 * routes/dispatch-replay.ts — POST /v1/dispatch-jobs/:id/replay
 *
 * Re-enqueues a dispatch_job that is in 'dead_letter' or 'failed' status,
 * resetting attempt_count to 0 and status to 'pending', then sends to
 * QUEUE_DISPATCH for reprocessing.
 *
 * CONTRACT-api-dispatch-replay-v1
 * T-ID: T-6-008
 *
 * ORCHESTRATOR MOUNT (adicionar em apps/edge/src/index.ts após as outras rotas):
 * import { dispatchReplayRoute } from './routes/dispatch-replay.js';
 * app.route('/v1/dispatch-jobs', dispatchReplayRoute);
 *
 * Auth (Sprint 6 placeholder):
 *   Requires `Authorization: Bearer <token>` header (non-empty).
 *   Missing / malformed → 401.
 *   TODO Sprint 6: validar JWT + RBAC — apenas OPERATOR/ADMIN (BR-RBAC)
 *
 * BR-DISPATCH-005: dead_letter não reprocessa automaticamente. Reprocessamento
 *   exige ação humana via requeueDeadLetter(job_id) chamada por OPERATOR/ADMIN.
 * BR-AUDIT-001: toda mutação sensível registra audit_log (action='reprocess_dlq').
 * BR-PRIVACY-001: zero PII em logs e error responses.
 * BR-RBAC-002: workspace_id is multi-tenant anchor — all queries scoped by workspace_id.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env types
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
};

type AppVariables = {
  workspace_id: string;
  request_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Validates that :id path param is a well-formed UUID. */
const JobIdParamSchema = z.object({
  id: z.string().uuid({ message: 'Job ID must be a valid UUID' }),
});

/**
 * Request body for replay.
 * BR-AUDIT-001: reason is mandatory for audit log — OPERATOR must justify re-dispatch.
 */
const ReplayBodySchema = z
  .object({
    reason: z
      .string()
      .min(10, 'reason must be at least 10 characters')
      .max(500, 'reason must be at most 500 characters'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Domain types injected via factory (no direct DB coupling in route)
// ---------------------------------------------------------------------------

/**
 * Minimal view of a dispatch_job needed by the replay handler.
 * domain-author wires this up via apps/edge/src/lib/dispatch.ts → getDispatchJobForReplay().
 */
export type DispatchJobForReplay = {
  id: string;
  workspace_id: string;
  destination: string;
  status: string;
};

export type GetDispatchJobFn = (
  jobId: string,
  workspaceId: string,
) => Promise<DispatchJobForReplay | null>;

/**
 * Updates dispatch_job status to 'pending' (resetting attempt_count + next_attempt_at).
 * Returns the updated row if the transition succeeded, or null on race condition (0 rows).
 * BR-DISPATCH-005: only valid from 'dead_letter' or 'failed' status.
 *
 * SQL (informational, executed by domain lib):
 * UPDATE dispatch_jobs
 * SET status='pending', attempt_count=0, next_attempt_at=NULL, updated_at=NOW()
 * WHERE id=$1 AND workspace_id=$2 AND status IN ('dead_letter','failed')
 * RETURNING id, destination, status
 */
export type RequeueDispatchJobFn = (
  jobId: string,
  workspaceId: string,
) => Promise<{ id: string; destination: string; status: string } | null>;

/**
 * Inserts an audit_log entry.
 * BR-AUDIT-001: every admin mutation generates an audit entry.
 */
export type InsertAuditEntryFn = (entry: {
  workspace_id: string;
  actor_id: string;
  actor_type: string;
  action: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  request_id: string;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create the dispatch-replay sub-router with injected dependencies.
 *
 * Usage in index.ts (wired by orchestrator):
 * ```ts
 * import { createDispatchReplayRoute } from './routes/dispatch-replay.js';
 * app.route('/v1/dispatch-jobs', createDispatchReplayRoute({ getDispatchJob, requeueDispatchJob, insertAuditEntry }));
 * ```
 */
export function createDispatchReplayRoute(deps?: {
  getDispatchJob?: GetDispatchJobFn;
  requeueDispatchJob?: RequeueDispatchJobFn;
  insertAuditEntry?: InsertAuditEntryFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // POST /:id/replay
  // CONTRACT-api-dispatch-replay-v1
  // BR-DISPATCH-005: manual requeue by OPERATOR/ADMIN
  // -------------------------------------------------------------------------
  route.post('/:id/replay', async (c) => {
    // request_id is set by sanitize-logs middleware. Fall back to generated UUID
    // if invoked without middleware (e.g., isolated unit tests).
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // workspace_id injected by auth middleware (real JWT in Sprint 6).
    // Fall back to a safe placeholder so the route is testable standalone.
    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ?? '';

    // -----------------------------------------------------------------------
    // 1. Auth — require non-empty Authorization: Bearer header.
    //    TODO Sprint 6: validar JWT + RBAC — apenas OPERATOR/ADMIN (BR-RBAC)
    // -----------------------------------------------------------------------
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing Authorization header',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!bearerMatch || !bearerMatch[1]?.trim()) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Invalid Authorization format',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    // BR-RBAC-003: apenas OPERATOR e ADMIN podem re-despachar jobs
    // TODO Sprint 6: extrair role do JWT e verificar
    // Por ora: aceita qualquer request autenticado com Bearer
    const actorId = bearerMatch[1].trim();

    // -----------------------------------------------------------------------
    // 2. Validate :id path param as UUID
    // -----------------------------------------------------------------------
    const paramParse = JobIdParamSchema.safeParse({ id: c.req.param('id') });

    if (!paramParse.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'id must be a valid UUID',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const jobId = paramParse.data.id;

    // -----------------------------------------------------------------------
    // 3. Validate request body (Zod .strict())
    // -----------------------------------------------------------------------
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          code: 'validation_error',
          message: 'Request body must be valid JSON',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const bodyParse = ReplayBodySchema.safeParse(rawBody);

    if (!bodyParse.success) {
      const firstError = bodyParse.error.errors[0];
      return c.json(
        {
          code: 'validation_error',
          message: firstError?.message ?? 'Invalid request body',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const body = bodyParse.data;

    // -----------------------------------------------------------------------
    // 4. Lookup dispatch_job in DB (if dep injected)
    //    BR-RBAC-002: scoped by workspace_id — cross-workspace leak prevention.
    // -----------------------------------------------------------------------
    if (deps?.getDispatchJob) {
      let job: DispatchJobForReplay | null;

      try {
        job = await deps.getDispatchJob(jobId, workspaceId);
      } catch (err) {
        // BR-PRIVACY-001: no PII in log — job_id is opaque UUID
        safeLog('error', {
          event: 'dispatch_replay_lookup_error',
          request_id: requestId,
          job_id: jobId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });

        return c.json(
          {
            code: 'internal_error',
            message: 'Failed to look up job',
            request_id: requestId,
          },
          500,
          { 'X-Request-Id': requestId },
        );
      }

      if (!job) {
        return c.json(
          {
            code: 'job_not_found',
            message: 'Dispatch job not found',
            request_id: requestId,
          },
          404,
          { 'X-Request-Id': requestId },
        );
      }

      // BR-DISPATCH-005: only 'dead_letter' or 'failed' jobs can be replayed
      if (job.status !== 'dead_letter' && job.status !== 'failed') {
        return c.json(
          {
            code: 'job_not_replayable',
            message:
              'Job precisa estar em status dead_letter ou failed para ser re-despachado',
            request_id: requestId,
          },
          409,
          { 'X-Request-Id': requestId },
        );
      }
    }

    // -----------------------------------------------------------------------
    // 5. Requeue — UPDATE dispatch_job to pending (BR-DISPATCH-005)
    //    SQL executed by domain lib (requeueDispatchJob):
    //    UPDATE dispatch_jobs
    //    SET status='pending', attempt_count=0, next_attempt_at=NULL, updated_at=NOW()
    //    WHERE id=$jobId AND workspace_id=$workspaceId AND status IN ('dead_letter','failed')
    //    RETURNING id, destination, status
    // -----------------------------------------------------------------------
    let requeuedJob: {
      id: string;
      destination: string;
      status: string;
    } | null = null;

    if (deps?.requeueDispatchJob) {
      try {
        requeuedJob = await deps.requeueDispatchJob(jobId, workspaceId);
      } catch (err) {
        // BR-PRIVACY-001: no PII in log
        safeLog('error', {
          event: 'dispatch_replay_requeue_error',
          request_id: requestId,
          job_id: jobId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });

        return c.json(
          {
            code: 'internal_error',
            message: 'Failed to requeue job',
            request_id: requestId,
          },
          500,
          { 'X-Request-Id': requestId },
        );
      }

      // Race condition — another process changed the status before our UPDATE
      if (!requeuedJob) {
        return c.json(
          {
            code: 'concurrent_modification',
            message: 'Job status changed concurrently; please retry',
            request_id: requestId,
          },
          409,
          { 'X-Request-Id': requestId },
        );
      }
    }

    const destination = requeuedJob?.destination ?? 'unknown';

    // -----------------------------------------------------------------------
    // 6. Enqueue in QUEUE_DISPATCH for async processing
    // -----------------------------------------------------------------------
    try {
      await c.env.QUEUE_DISPATCH.send({
        dispatch_job_id: jobId,
        destination,
      });
    } catch (err) {
      // BR-PRIVACY-001: no PII in log
      safeLog('error', {
        event: 'dispatch_replay_queue_send_error',
        request_id: requestId,
        job_id: jobId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });

      return c.json(
        {
          code: 'internal_error',
          message: 'Failed to enqueue job for reprocessing',
          request_id: requestId,
        },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 7. Audit log
    //    BR-AUDIT-001: toda mutação sensível registra audit_log.
    //    action='reprocess_dlq' — canonical action per 06-audit-trail-spec.md.
    //    BR-PRIVACY-001: no PII in metadata — job_id opaque UUID, reason is
    //      operator-supplied justification text (no user PII).
    // -----------------------------------------------------------------------
    if (deps?.insertAuditEntry) {
      try {
        await deps.insertAuditEntry({
          workspace_id: workspaceId,
          actor_id: actorId,
          actor_type: 'user',
          action: 'reprocess_dlq',
          entity_type: 'dispatch_job',
          entity_id: jobId,
          metadata: { reason: body.reason, destination },
          request_id: requestId,
        });
      } catch (err) {
        // BR-AUDIT-001: log warning but do not fail the request — job is already
        // re-enqueued. A separate audit reconciliation pass can recover this.
        // BR-PRIVACY-001: no PII in log.
        safeLog('warn', {
          event: '[AUDIT-PENDING] reprocess_dlq',
          request_id: requestId,
          job_id: jobId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    } else {
      // No audit dep injected — log pending
      safeLog('warn', {
        event: '[AUDIT-PENDING] reprocess_dlq',
        request_id: requestId,
        job_id: jobId,
      });
    }

    // -----------------------------------------------------------------------
    // 8. Return 200
    //    CONTRACT-api-dispatch-replay-v1 response shape.
    // -----------------------------------------------------------------------
    return c.json(
      {
        queued: true,
        job_id: jobId,
        destination,
        message: 'Job enfileirado para re-processamento',
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance with no-op stubs.
// Callers should prefer createDispatchReplayRoute(deps) to wire real DB.
// ---------------------------------------------------------------------------

/**
 * Default dispatchReplayRoute instance — DB calls use stub (no-op) behaviour.
 *
 * Wire real dependencies in index.ts via:
 * ```ts
 * app.route('/v1/dispatch-jobs', createDispatchReplayRoute({ getDispatchJob, requeueDispatchJob, insertAuditEntry }));
 * ```
 */
export const dispatchReplayRoute = createDispatchReplayRoute();
