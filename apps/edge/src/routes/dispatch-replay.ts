/**
 * routes/dispatch-replay.ts — POST /v1/dispatch-jobs/:id/replay
 *
 * Creates a NEW dispatch_job child from the original job (failed/dead_letter/succeeded),
 * linking it via replayed_from_dispatch_job_id, then enqueues for reprocessing.
 *
 * CONTRACT-api-dispatch-replay-v1
 * T-ID: T-8-009
 *
 * ORCHESTRATOR MOUNT (adicionar em apps/edge/src/index.ts após as outras rotas):
 * import { createDispatchReplayRoute } from './routes/dispatch-replay.js';
 * app.route('/v1/dispatch-jobs', createDispatchReplayRoute({ getDispatchJob, createReplayJob, insertAuditEntry }));
 *
 * Auth (Sprint 6 placeholder):
 *   Requires `Authorization: Bearer <token>` header (non-empty).
 *   Missing / malformed → 401.
 *   TODO Sprint 6: validar JWT + RBAC — apenas OPERATOR/ADMIN (BR-RBAC)
 *
 * ADR-025: dispatch-replay cria novo job filho (não reseta o existente).
 * BR-DISPATCH-001: idempotency_key único — replay usa computeReplayIdempotencyKey().
 * BR-DISPATCH-005: dead_letter não reprocessa automaticamente; requer ação manual.
 * BR-AUDIT-001: toda mutação sensível registra audit_log (action='replay_dispatch').
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
 * CONTRACT-api-dispatch-replay-v1: body = { test_mode?: boolean, justification: string }
 * BR-AUDIT-001: justification is mandatory — OPERATOR must justify re-dispatch.
 */
const ReplayBodySchema = z
  .object({
    justification: z
      .string()
      .min(1, 'justification is required and must not be empty')
      .max(500, 'justification must be at most 500 characters'),
    test_mode: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Domain types injected via factory (no direct DB coupling in route)
// ---------------------------------------------------------------------------

/**
 * Full view of a dispatch_job needed to create a replay child.
 * domain-author wires this up via apps/edge/src/lib/dispatch.ts → getDispatchJobForReplay().
 */
export type DispatchJobForReplay = {
  id: string;
  workspace_id: string;
  lead_id: string | null;
  event_id: string;
  event_workspace_id: string;
  destination: string;
  destination_account_id: string;
  destination_resource_id: string;
  destination_subresource: string | null;
  max_attempts: number;
  payload: Record<string, unknown>;
  status: string;
};

export type GetDispatchJobFn = (
  jobId: string,
  workspaceId: string,
) => Promise<DispatchJobForReplay | null>;

/**
 * Creates a new dispatch_job child from the replay request.
 * Returns the newly created job id.
 * ADR-025: create new job — never reset the original.
 * BR-DISPATCH-001: caller must pass a replay-specific idempotency_key.
 */
export type CreateReplayJobFn = (params: {
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
}) => Promise<{ id: string; destination: string }>;

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
 * app.route('/v1/dispatch-jobs', createDispatchReplayRoute({ getDispatchJob, createReplayJob, insertAuditEntry }));
 * ```
 */
export function createDispatchReplayRoute(deps?: {
  getDispatchJob?: GetDispatchJobFn;
  createReplayJob?: CreateReplayJobFn;
  insertAuditEntry?: InsertAuditEntryFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // POST /:id/replay
  // CONTRACT-api-dispatch-replay-v1
  // ADR-025: creates a new dispatch_job child — does NOT reset the original.
  // -------------------------------------------------------------------------
  route.post('/:id/replay', async (c) => {
    // request_id is set by sanitize-logs middleware. Fall back to generated UUID
    // if invoked without middleware (e.g., isolated unit tests).
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // workspace_id injected by auth middleware (real JWT in Sprint 6).
    // Until middleware exists, accept X-Workspace-Id header as fallback —
    // alinhado com auth Bearer placeholder do mesmo handler. Vazio causaria
    // erro de cast UUID em getDispatchJob (PostgreSQL 22P02).
    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ??
      c.req.header('X-Workspace-Id') ??
      '';

    // -----------------------------------------------------------------------
    // 1. Validate request body (Zod .strict()) — done first per ADR-004
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
    // 2. Auth — require non-empty Authorization: Bearer header.
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
    // 3. Validate :id path param as UUID
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
    // 4. Lookup dispatch_job in DB (if dep injected)
    //    BR-RBAC-002: scoped by workspace_id — cross-workspace leak prevention.
    // -----------------------------------------------------------------------
    let originalJob: DispatchJobForReplay | null = null;

    if (deps?.getDispatchJob) {
      try {
        originalJob = await deps.getDispatchJob(jobId, workspaceId);
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

      if (!originalJob) {
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

      // ADR-025 / BR-DISPATCH-005: jobs in progress cannot be replayed — would
      //   create a duplicate active job for the same destination.
      // Replayable states: 'failed', 'dead_letter', 'succeeded'.
      // Non-replayable: 'pending', 'processing', 'retrying'.
      const IN_PROGRESS_STATUSES = new Set(['pending', 'processing', 'retrying']);
      if (IN_PROGRESS_STATUSES.has(originalJob.status)) {
        return c.json(
          {
            error: 'not_replayable',
            reason: 'job_in_progress',
            request_id: requestId,
          },
          409,
          { 'X-Request-Id': requestId },
        );
      }
    }

    // -----------------------------------------------------------------------
    // 5. Compute replay idempotency key and create new child job.
    //    ADR-025: create new dispatch_job — never modify the original.
    //    BR-DISPATCH-001: replay key formula = sha256(original_id|'replay'|replayed_at)
    // -----------------------------------------------------------------------
    const replayedAt = new Date().toISOString();

    // Inline key derivation (Web Crypto available in CF Workers and Node).
    // ADR-025: sha256(original_id|'replay'|replayed_at_iso)
    const rawKey = [jobId, 'replay', replayedAt].join('|');
    const keyEncoded = new TextEncoder().encode(rawKey);
    const keyBuffer = await crypto.subtle.digest('SHA-256', keyEncoded);
    const replayIdempotencyKey = Array.from(new Uint8Array(keyBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    let newJobId: string;
    let destination: string;

    if (deps?.createReplayJob && originalJob) {
      // Build payload for new job — optionally flag as test if test_mode=true
      // BR-PRIVACY-001: payload jsonb must not contain PII in clear
      const replayPayload: Record<string, unknown> = {
        ...originalJob.payload,
        ...(body.test_mode === true ? { is_test: true } : {}),
      };

      let createdJob: { id: string; destination: string };
      try {
        // ADR-025: pass replayed_from_dispatch_job_id to link child → parent
        createdJob = await deps.createReplayJob({
          workspace_id: originalJob.workspace_id,
          lead_id: originalJob.lead_id,
          event_id: originalJob.event_id,
          event_workspace_id: originalJob.event_workspace_id,
          destination: originalJob.destination,
          destination_account_id: originalJob.destination_account_id,
          destination_resource_id: originalJob.destination_resource_id,
          destination_subresource: originalJob.destination_subresource,
          payload: replayPayload,
          max_attempts: originalJob.max_attempts,
          idempotency_key: replayIdempotencyKey,
          replayed_from_dispatch_job_id: jobId,
        });
      } catch (err) {
        // BR-PRIVACY-001: no PII in log
        safeLog('error', {
          event: 'dispatch_replay_create_job_error',
          request_id: requestId,
          job_id: jobId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });

        return c.json(
          {
            code: 'internal_error',
            message: 'Failed to create replay job',
            request_id: requestId,
          },
          500,
          { 'X-Request-Id': requestId },
        );
      }

      newJobId = createdJob.id;
      destination = createdJob.destination;
    } else {
      // No dep injected (standalone test mode) — use deterministic stubs
      newJobId = crypto.randomUUID();
      destination = originalJob?.destination ?? 'unknown';
    }

    // -----------------------------------------------------------------------
    // 6. Enqueue new job in QUEUE_DISPATCH for async processing
    // -----------------------------------------------------------------------
    try {
      await c.env.QUEUE_DISPATCH.send({
        dispatch_job_id: newJobId,
        destination,
      });
    } catch (err) {
      // BR-PRIVACY-001: no PII in log
      safeLog('error', {
        event: 'dispatch_replay_queue_send_error',
        request_id: requestId,
        new_job_id: newJobId,
        original_job_id: jobId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });

      return c.json(
        {
          code: 'internal_error',
          message: 'Failed to enqueue replay job',
          request_id: requestId,
        },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 7. Audit log
    //    BR-AUDIT-001: toda mutação sensível registra audit_log.
    //    action='replay_dispatch' — CONTRACT-api-dispatch-replay-v1.
    //    BR-PRIVACY-001: no PII in metadata — job IDs are opaque UUIDs.
    // -----------------------------------------------------------------------
    if (deps?.insertAuditEntry) {
      try {
        await deps.insertAuditEntry({
          workspace_id: workspaceId,
          actor_id: actorId,
          actor_type: 'user',
          action: 'replay_dispatch',
          entity_type: 'dispatch_job',
          entity_id: newJobId,
          metadata: {
            original_job_id: jobId,
            new_job_id: newJobId,
            justification: body.justification,
            test_mode: body.test_mode ?? false,
          },
          request_id: requestId,
        });
      } catch (err) {
        // BR-AUDIT-001: log warning but do not fail the request — job is already
        // enqueued. A separate audit reconciliation pass can recover this.
        // BR-PRIVACY-001: no PII in log.
        safeLog('warn', {
          event: '[AUDIT-PENDING] replay_dispatch',
          request_id: requestId,
          new_job_id: newJobId,
          original_job_id: jobId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    } else {
      // No audit dep injected — log pending
      safeLog('warn', {
        event: '[AUDIT-PENDING] replay_dispatch',
        request_id: requestId,
        new_job_id: newJobId,
        original_job_id: jobId,
      });
    }

    // -----------------------------------------------------------------------
    // 8. Return 202
    //    CONTRACT-api-dispatch-replay-v1 response shape: { new_job_id, status: 'queued' }
    // -----------------------------------------------------------------------
    return c.json(
      {
        new_job_id: newJobId,
        status: 'queued' as const,
      },
      202,
      { 'X-Request-Id': requestId },
    );
  });

  return route;
}

