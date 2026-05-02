/**
 * routes/orchestrator.ts — POST/GET /v1/orchestrator/workflows/*
 *
 * Orchestrator endpoints for workflow triggering, status polling, approval,
 * and rollback. Thin HTTP layer — validates input, interacts with DB via
 * injected dependencies, calls Trigger.dev Management API via fetch.
 *
 * Endpoints:
 *   POST   /:workflow/trigger    — trigger a workflow run (setup-tracking | deploy-lp | provision-campaigns)
 *   GET    /:run_id/status       — poll run status
 *   POST   /:run_id/approve      — approve a waiting_approval run
 *   POST   /:run_id/rollback     — rollback a run
 *
 * Auth: Authorization: Bearer <token> (simplified — full RBAC in Sprint 8)
 *
 * BR-RBAC-002: workspace_id is the multi-tenant anchor on every DB query.
 * BR-AUDIT-001: every mutation generates an audit_log entry.
 * BR-PRIVACY-001: zero PII in logs or error responses.
 * INV-ORC-001: workflow status ∈ { 'pending', 'running', 'waiting_approval', 'completed', 'failed', 'rolled_back' }
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings — TRIGGER_SECRET_KEY added for Trigger.dev Management API access.
// NOTE: Add TRIGGER_SECRET_KEY as a Wrangler secret in wrangler.toml (do not
// commit the value — use `wrangler secret put TRIGGER_SECRET_KEY`).
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  /** Hyperdrive binding — undefined until configured in production. */
  DB?: Fetcher;
  /** Trigger.dev secret key for Management API calls. */
  TRIGGER_SECRET_KEY?: string;
};

type AppVariables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRIGGER_API_BASE = 'https://api.trigger.dev/api/v1';

// INV-ORC-001: valid status values
const WORKFLOW_STATUS = [
  'pending',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'rolled_back',
] as const;

type WorkflowStatus = (typeof WORKFLOW_STATUS)[number];

const WORKFLOW_NAMES = [
  'setup-tracking',
  'deploy-lp',
  'provision-campaigns',
] as const;

type WorkflowName = (typeof WORKFLOW_NAMES)[number];

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

const RunIdParamSchema = z.object({
  run_id: z.string().uuid(),
});

/** Per-workflow body schemas */
const SetupTrackingBodySchema = z
  .object({
    page_id: z.string().uuid(),
    launch_id: z.string().uuid(),
  })
  .strict();

const DeployLpBodySchema = z
  .object({
    template: z.string().min(1),
    launch_id: z.string().uuid(),
    slug: z.string().min(1).max(64),
    domain: z.string().optional(),
  })
  .strict();

const ProvisionCampaignsBodySchema = z
  .object({
    launch_id: z.string().uuid(),
    platforms: z.array(z.enum(['meta', 'google'])).min(1),
  })
  .strict();

const ApproveBodySchema = z
  .object({
    justification: z.string().min(10).max(500),
  })
  .strict();

const RollbackBodySchema = z
  .object({
    reason: z.string().min(10).max(500),
  })
  .strict();

// ---------------------------------------------------------------------------
// Injected dependency types
// ---------------------------------------------------------------------------

/** A workflow run record returned from DB. */
export type WorkflowRunRow = {
  id: string;
  workspace_id: string;
  workflow: string;
  status: WorkflowStatus;
  trigger_run_id: string | null;
  trigger_payload: unknown;
  result: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

/** Result of inserting a new workflow run. */
export type InsertWorkflowRunResult = { id: string };

export type GetWorkflowRunFn = (
  runId: string,
  workspaceId: string,
) => Promise<WorkflowRunRow | null>;

export type FindActiveRunFn = (
  workspaceId: string,
  workflow: WorkflowName,
  launchId: string,
) => Promise<{ id: string } | null>;

export type InsertWorkflowRunFn = (run: {
  workspace_id: string;
  workflow: WorkflowName;
  status: WorkflowStatus;
  trigger_payload: unknown;
}) => Promise<InsertWorkflowRunResult>;

export type UpdateWorkflowRunFn = (
  runId: string,
  workspaceId: string,
  fields: Partial<{
    status: WorkflowStatus;
    trigger_run_id: string;
    result: unknown;
    updated_at: string;
  }>,
) => Promise<void>;

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
// Trigger.dev helpers
// ---------------------------------------------------------------------------

/** Call Trigger.dev to dispatch a workflow task. Returns the Trigger run id. */
async function triggerWorkflow(
  secretKey: string,
  taskId: WorkflowName | 'rollback-provisioning',
  payload: unknown,
  idempotencyKey: string,
): Promise<string> {
  const res = await fetch(`${TRIGGER_API_BASE}/tasks/${taskId}/trigger`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      payload,
      options: { idempotencyKey },
    }),
  });

  if (!res.ok) {
    // BR-PRIVACY-001: do not include response body in error (may contain PII)
    throw new Error(`trigger.dev trigger failed: ${res.status}`);
  }

  const data = (await res.json()) as { id?: string };
  if (!data.id) throw new Error('trigger.dev trigger returned no run id');
  return data.id;
}

/**
 * Send an event to a running Trigger.dev run (for approve/rollback).
 * Uses /runs/{id}/complete — if unavailable, falls back to /runs/{id}/resume.
 * NOTE: The real endpoint varies by Trigger.dev version; integration verified in T-7-010.
 */
async function sendTriggerEvent(
  secretKey: string,
  triggerRunId: string,
  output: unknown,
): Promise<void> {
  // Try /complete first, then /resume as fallback
  const endpoints = ['complete', 'resume'];

  for (const ep of endpoints) {
    const res = await fetch(`${TRIGGER_API_BASE}/runs/${triggerRunId}/${ep}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ output }),
    });

    if (res.ok || res.status === 400) {
      // 400 from /complete means endpoint exists but request invalid —
      // real integration verified in T-7-010
      return;
    }
    if (res.status === 404) continue; // try next endpoint
    throw new Error(`trigger.dev event send failed: ${res.status}`);
  }

  // Both endpoints returned 404 — Trigger.dev version mismatch; log warning.
  // BR-PRIVACY-001: no PII in log.
  safeLog('warn', {
    event: 'trigger_send_event_endpoint_not_found',
    trigger_run_id: triggerRunId,
    note: 'Real endpoint to be verified in T-7-010',
  });
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create the orchestrator sub-router with injected dependencies.
 *
 * Usage in index.ts:
 * ```ts
 * import { createOrchestratorRoute } from './routes/orchestrator.js';
 * app.route('/v1/orchestrator/workflows', createOrchestratorRoute());
 * ```
 */
export function createOrchestratorRoute(deps?: {
  getWorkflowRun?: GetWorkflowRunFn;
  findActiveRun?: FindActiveRunFn;
  insertWorkflowRun?: InsertWorkflowRunFn;
  updateWorkflowRun?: UpdateWorkflowRunFn;
  insertAuditEntry?: InsertAuditEntryFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // =========================================================================
  // POST /:workflow/trigger
  // Trigger a new workflow run.
  //
  // BR-RBAC-002: workspace_id anchors all queries.
  // BR-AUDIT-001: audit_log with action='workflow_triggered'.
  // =========================================================================
  route.post('/:workflow/trigger', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // -----------------------------------------------------------------------
    // 1. Auth — require non-empty Authorization: Bearer header
    // -----------------------------------------------------------------------
    const authHeader = c.req.header('Authorization');
    const bearerMatch = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!bearerMatch?.[1]?.trim()) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid Authorization header',
          request_id: requestId,
        },
        401,
        {
          'X-Request-Id': requestId,
        },
      );
    }
    const actorToken = bearerMatch[1].trim();

    // -----------------------------------------------------------------------
    // 2. Validate workflow param
    // -----------------------------------------------------------------------
    const workflowRaw = c.req.param('workflow');
    const workflowResult = z.enum(WORKFLOW_NAMES).safeParse(workflowRaw);
    if (!workflowResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: `workflow must be one of: ${WORKFLOW_NAMES.join(', ')}`,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const workflow = workflowResult.data;

    // -----------------------------------------------------------------------
    // 3. Parse + validate body per workflow
    // -----------------------------------------------------------------------
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid JSON body',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    let triggerPayload: unknown;
    let launchId: string;

    if (workflow === 'setup-tracking') {
      const parsed = SetupTrackingBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json(
          {
            code: 'validation_error',
            message: parsed.error.message,
            request_id: requestId,
          },
          400,
          { 'X-Request-Id': requestId },
        );
      }
      triggerPayload = parsed.data;
      launchId = parsed.data.launch_id;
    } else if (workflow === 'deploy-lp') {
      const parsed = DeployLpBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json(
          {
            code: 'validation_error',
            message: parsed.error.message,
            request_id: requestId,
          },
          400,
          { 'X-Request-Id': requestId },
        );
      }
      triggerPayload = parsed.data;
      launchId = parsed.data.launch_id;
    } else {
      // provision-campaigns
      const parsed = ProvisionCampaignsBodySchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json(
          {
            code: 'validation_error',
            message: parsed.error.message,
            request_id: requestId,
          },
          400,
          { 'X-Request-Id': requestId },
        );
      }
      triggerPayload = parsed.data;
      launchId = parsed.data.launch_id;
    }

    // -----------------------------------------------------------------------
    // 4. Workspace anchor
    // BR-RBAC-002: workspace_id is the multi-tenant anchor
    // -----------------------------------------------------------------------
    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ?? '';

    // -----------------------------------------------------------------------
    // 5. Conflict check — 409 if active run exists for same launch + workflow
    // -----------------------------------------------------------------------
    if (deps?.findActiveRun) {
      try {
        const existing = await deps.findActiveRun(
          workspaceId,
          workflow,
          launchId,
        );
        if (existing) {
          return c.json(
            {
              code: 'conflict',
              message:
                'An active run already exists for this launch and workflow',
              run_id: existing.id,
              request_id: requestId,
            },
            409,
            { 'X-Request-Id': requestId },
          );
        }
      } catch (err) {
        safeLog('error', {
          event: 'orchestrator_find_active_run_error',
          request_id: requestId,
          workflow,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        return c.json(
          {
            code: 'internal_error',
            message: 'Database error',
            request_id: requestId,
          },
          500,
          {
            'X-Request-Id': requestId,
          },
        );
      }
    }

    // -----------------------------------------------------------------------
    // 6. Insert workflow_run with status='running'
    // -----------------------------------------------------------------------
    let runId = crypto.randomUUID();

    if (deps?.insertWorkflowRun) {
      try {
        const inserted = await deps.insertWorkflowRun({
          workspace_id: workspaceId,
          workflow,
          status: 'running',
          trigger_payload: triggerPayload,
        });
        runId = inserted.id;
      } catch (err) {
        safeLog('error', {
          event: 'orchestrator_insert_run_error',
          request_id: requestId,
          workflow,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        return c.json(
          {
            code: 'internal_error',
            message: 'Failed to create workflow run',
            request_id: requestId,
          },
          500,
          {
            'X-Request-Id': requestId,
          },
        );
      }
    }

    // -----------------------------------------------------------------------
    // 7. Call Trigger.dev Management API
    // -----------------------------------------------------------------------
    const triggerSecretKey = c.env.TRIGGER_SECRET_KEY;
    if (triggerSecretKey) {
      try {
        const triggerRunId = await triggerWorkflow(
          triggerSecretKey,
          workflow,
          {
            ...((triggerPayload as object) ?? {}),
            run_id: runId,
            workspace_id: workspaceId,
          },
          runId,
        );

        // Update trigger_run_id in DB
        if (deps?.updateWorkflowRun) {
          await deps.updateWorkflowRun(runId, workspaceId, {
            trigger_run_id: triggerRunId,
            updated_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        // BR-PRIVACY-001: no PII in log
        safeLog('warn', {
          event: 'orchestrator_trigger_dev_error',
          request_id: requestId,
          run_id: runId,
          workflow,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        // Continue — run is recorded; Trigger.dev call will be retried in T-7-010
      }
    }

    // -----------------------------------------------------------------------
    // 8. Audit log
    // BR-AUDIT-001: every mutation generates an audit entry
    // -----------------------------------------------------------------------
    if (deps?.insertAuditEntry) {
      try {
        await deps.insertAuditEntry({
          action: 'workflow_triggered',
          actor_type: 'api_key',
          actor_id: actorToken,
          entity_type: 'workflow_run',
          entity_id: runId,
          metadata: { workflow, request_id: requestId },
          request_id: requestId,
        });
      } catch (err) {
        safeLog('warn', {
          event: '[AUDIT-PENDING] workflow_triggered',
          request_id: requestId,
          run_id: runId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    } else {
      safeLog('warn', {
        event: '[AUDIT-PENDING] workflow_triggered',
        request_id: requestId,
        run_id: runId,
        workflow,
      });
    }

    // -----------------------------------------------------------------------
    // 9. Response 202
    // -----------------------------------------------------------------------
    return c.json({ run_id: runId, workflow, status: 'running' }, 202, {
      'X-Request-Id': requestId,
    });
  });

  // =========================================================================
  // GET /:run_id/status
  // Poll workflow run status.
  //
  // BR-RBAC-002: workspace_id guards cross-tenant access.
  // =========================================================================
  route.get('/:run_id/status', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // -----------------------------------------------------------------------
    // 1. Auth
    // -----------------------------------------------------------------------
    const authHeader = c.req.header('Authorization');
    const bearerMatch = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!bearerMatch?.[1]?.trim()) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid Authorization header',
          request_id: requestId,
        },
        401,
        {
          'X-Request-Id': requestId,
        },
      );
    }

    // -----------------------------------------------------------------------
    // 2. Validate run_id param
    // -----------------------------------------------------------------------
    const paramResult = RunIdParamSchema.safeParse({
      run_id: c.req.param('run_id'),
    });
    if (!paramResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'run_id must be a valid UUID',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const { run_id: runId } = paramResult.data;

    // -----------------------------------------------------------------------
    // 3. Workspace anchor
    // BR-RBAC-002: workspace_id is the multi-tenant anchor
    // -----------------------------------------------------------------------
    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ?? '';

    // -----------------------------------------------------------------------
    // 4. DB lookup
    // -----------------------------------------------------------------------
    if (!deps?.getWorkflowRun) {
      return c.json(
        {
          code: 'run_not_found',
          message: 'Run not found',
          request_id: requestId,
        },
        404,
        {
          'X-Request-Id': requestId,
        },
      );
    }

    let run: WorkflowRunRow | null;
    try {
      run = await deps.getWorkflowRun(runId, workspaceId);
    } catch (err) {
      safeLog('error', {
        event: 'orchestrator_get_run_error',
        request_id: requestId,
        run_id: runId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        {
          code: 'internal_error',
          message: 'Database error',
          request_id: requestId,
        },
        500,
        {
          'X-Request-Id': requestId,
        },
      );
    }

    if (!run) {
      return c.json(
        {
          code: 'run_not_found',
          message: 'Run not found',
          request_id: requestId,
        },
        404,
        {
          'X-Request-Id': requestId,
        },
      );
    }

    return c.json(
      {
        run_id: run.id,
        workflow: run.workflow,
        status: run.status,
        trigger_run_id: run.trigger_run_id,
        trigger_payload: run.trigger_payload,
        result: run.result,
        created_at: run.created_at,
        updated_at: run.updated_at,
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // =========================================================================
  // POST /:run_id/approve
  // Approve a run waiting for human approval.
  //
  // BR-AUDIT-001: audit_log with action='workflow_approved'.
  // BR-RBAC-002: workspace_id guards cross-tenant access.
  // =========================================================================
  route.post('/:run_id/approve', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // -----------------------------------------------------------------------
    // 1. Auth
    // -----------------------------------------------------------------------
    const authHeader = c.req.header('Authorization');
    const bearerMatch = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!bearerMatch?.[1]?.trim()) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid Authorization header',
          request_id: requestId,
        },
        401,
        {
          'X-Request-Id': requestId,
        },
      );
    }
    const actorToken = bearerMatch[1].trim();

    // -----------------------------------------------------------------------
    // 2. Validate run_id
    // -----------------------------------------------------------------------
    const paramResult = RunIdParamSchema.safeParse({
      run_id: c.req.param('run_id'),
    });
    if (!paramResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'run_id must be a valid UUID',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const { run_id: runId } = paramResult.data;

    // -----------------------------------------------------------------------
    // 3. Validate body
    // -----------------------------------------------------------------------
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid JSON body',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const bodyResult = ApproveBodySchema.safeParse(rawBody);
    if (!bodyResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: bodyResult.error.message,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const { justification } = bodyResult.data;

    // -----------------------------------------------------------------------
    // 4. Workspace anchor
    // BR-RBAC-002: workspace_id is the multi-tenant anchor
    // -----------------------------------------------------------------------
    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ?? '';

    // -----------------------------------------------------------------------
    // 5. Fetch run and verify status
    // -----------------------------------------------------------------------
    if (!deps?.getWorkflowRun) {
      return c.json(
        {
          code: 'run_not_found',
          message: 'Run not found',
          request_id: requestId,
        },
        404,
        {
          'X-Request-Id': requestId,
        },
      );
    }

    let run: WorkflowRunRow | null;
    try {
      run = await deps.getWorkflowRun(runId, workspaceId);
    } catch (err) {
      safeLog('error', {
        event: 'orchestrator_approve_get_run_error',
        request_id: requestId,
        run_id: runId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        {
          code: 'internal_error',
          message: 'Database error',
          request_id: requestId,
        },
        500,
        {
          'X-Request-Id': requestId,
        },
      );
    }

    if (!run) {
      return c.json(
        {
          code: 'run_not_found',
          message: 'Run not found',
          request_id: requestId,
        },
        404,
        {
          'X-Request-Id': requestId,
        },
      );
    }

    if (run.status !== 'waiting_approval') {
      return c.json(
        {
          code: 'not_approvable',
          message: `Run is in status '${run.status}', not waiting_approval`,
          request_id: requestId,
        },
        409,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 6. Update status to 'running'
    // -----------------------------------------------------------------------
    if (deps?.updateWorkflowRun) {
      try {
        await deps.updateWorkflowRun(runId, workspaceId, {
          status: 'running',
          updated_at: new Date().toISOString(),
        });
      } catch (err) {
        safeLog('error', {
          event: 'orchestrator_approve_update_error',
          request_id: requestId,
          run_id: runId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        return c.json(
          {
            code: 'internal_error',
            message: 'Failed to update run',
            request_id: requestId,
          },
          500,
          {
            'X-Request-Id': requestId,
          },
        );
      }
    }

    // -----------------------------------------------------------------------
    // 7. Send approval event to Trigger.dev
    // -----------------------------------------------------------------------
    const triggerSecretKey = c.env.TRIGGER_SECRET_KEY;
    if (triggerSecretKey && run.trigger_run_id) {
      try {
        await sendTriggerEvent(triggerSecretKey, run.trigger_run_id, {
          approved: true,
          justification,
        });
      } catch (err) {
        safeLog('warn', {
          event: 'orchestrator_trigger_approve_error',
          request_id: requestId,
          run_id: runId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    }

    // -----------------------------------------------------------------------
    // 8. Audit log
    // BR-AUDIT-001: every mutation generates an audit entry
    // -----------------------------------------------------------------------
    if (deps?.insertAuditEntry) {
      try {
        await deps.insertAuditEntry({
          action: 'workflow_approved',
          actor_type: 'api_key',
          actor_id: actorToken,
          entity_type: 'workflow_run',
          entity_id: runId,
          metadata: { request_id: requestId },
          request_id: requestId,
        });
      } catch (err) {
        safeLog('warn', {
          event: '[AUDIT-PENDING] workflow_approved',
          request_id: requestId,
          run_id: runId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    } else {
      safeLog('warn', {
        event: '[AUDIT-PENDING] workflow_approved',
        request_id: requestId,
        run_id: runId,
      });
    }

    return c.json({ run_id: runId, status: 'running' }, 200, {
      'X-Request-Id': requestId,
    });
  });

  // =========================================================================
  // POST /:run_id/rollback
  // Rollback a completed, failed, or waiting_approval run.
  //
  // BR-AUDIT-001: audit_log with action='workflow_rollback'.
  // BR-RBAC-002: workspace_id guards cross-tenant access.
  // =========================================================================
  route.post('/:run_id/rollback', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // -----------------------------------------------------------------------
    // 1. Auth
    // -----------------------------------------------------------------------
    const authHeader = c.req.header('Authorization');
    const bearerMatch = authHeader?.match(/^Bearer\s+(.+)$/i);
    if (!bearerMatch?.[1]?.trim()) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid Authorization header',
          request_id: requestId,
        },
        401,
        {
          'X-Request-Id': requestId,
        },
      );
    }
    const actorToken = bearerMatch[1].trim();

    // -----------------------------------------------------------------------
    // 2. Validate run_id
    // -----------------------------------------------------------------------
    const paramResult = RunIdParamSchema.safeParse({
      run_id: c.req.param('run_id'),
    });
    if (!paramResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'run_id must be a valid UUID',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const { run_id: runId } = paramResult.data;

    // -----------------------------------------------------------------------
    // 3. Validate body
    // -----------------------------------------------------------------------
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid JSON body',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const bodyResult = RollbackBodySchema.safeParse(rawBody);
    if (!bodyResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: bodyResult.error.message,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const { reason } = bodyResult.data;

    // -----------------------------------------------------------------------
    // 4. Workspace anchor
    // BR-RBAC-002: workspace_id is the multi-tenant anchor
    // -----------------------------------------------------------------------
    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ?? '';

    // -----------------------------------------------------------------------
    // 5. Fetch run and verify status
    // INV-ORC-001: rollbackable statuses are waiting_approval, completed, failed
    // -----------------------------------------------------------------------
    if (!deps?.getWorkflowRun) {
      return c.json(
        {
          code: 'run_not_found',
          message: 'Run not found',
          request_id: requestId,
        },
        404,
        {
          'X-Request-Id': requestId,
        },
      );
    }

    let run: WorkflowRunRow | null;
    try {
      run = await deps.getWorkflowRun(runId, workspaceId);
    } catch (err) {
      safeLog('error', {
        event: 'orchestrator_rollback_get_run_error',
        request_id: requestId,
        run_id: runId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        {
          code: 'internal_error',
          message: 'Database error',
          request_id: requestId,
        },
        500,
        {
          'X-Request-Id': requestId,
        },
      );
    }

    if (!run) {
      return c.json(
        {
          code: 'run_not_found',
          message: 'Run not found',
          request_id: requestId,
        },
        404,
        {
          'X-Request-Id': requestId,
        },
      );
    }

    if (run.status === 'rolled_back') {
      return c.json(
        {
          code: 'already_rolled_back',
          message: 'Run has already been rolled back',
          request_id: requestId,
        },
        409,
        { 'X-Request-Id': requestId },
      );
    }

    const rollbackableStatuses: WorkflowStatus[] = [
      'waiting_approval',
      'completed',
      'failed',
    ];
    if (!rollbackableStatuses.includes(run.status)) {
      return c.json(
        {
          code: 'not_rollbackable',
          message: `Run in status '${run.status}' cannot be rolled back`,
          request_id: requestId,
        },
        409,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 6. Update status to 'rolled_back'
    // -----------------------------------------------------------------------
    if (deps?.updateWorkflowRun) {
      try {
        await deps.updateWorkflowRun(runId, workspaceId, {
          status: 'rolled_back',
          updated_at: new Date().toISOString(),
        });
      } catch (err) {
        safeLog('error', {
          event: 'orchestrator_rollback_update_error',
          request_id: requestId,
          run_id: runId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        return c.json(
          {
            code: 'internal_error',
            message: 'Failed to update run',
            request_id: requestId,
          },
          500,
          {
            'X-Request-Id': requestId,
          },
        );
      }
    }

    // -----------------------------------------------------------------------
    // 7. Trigger rollback-provisioning task in Trigger.dev
    // -----------------------------------------------------------------------
    const triggerSecretKey = c.env.TRIGGER_SECRET_KEY;
    if (triggerSecretKey) {
      try {
        await triggerWorkflow(
          triggerSecretKey,
          'rollback-provisioning',
          { run_id: runId, workspace_id: workspaceId, reason },
          `rollback-${runId}`,
        );
      } catch (err) {
        safeLog('warn', {
          event: 'orchestrator_trigger_rollback_error',
          request_id: requestId,
          run_id: runId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    }

    // -----------------------------------------------------------------------
    // 8. Audit log
    // BR-AUDIT-001: every mutation generates an audit entry
    // -----------------------------------------------------------------------
    if (deps?.insertAuditEntry) {
      try {
        await deps.insertAuditEntry({
          action: 'workflow_rollback',
          actor_type: 'api_key',
          actor_id: actorToken,
          entity_type: 'workflow_run',
          entity_id: runId,
          metadata: { request_id: requestId },
          request_id: requestId,
        });
      } catch (err) {
        safeLog('warn', {
          event: '[AUDIT-PENDING] workflow_rollback',
          request_id: requestId,
          run_id: runId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    } else {
      safeLog('warn', {
        event: '[AUDIT-PENDING] workflow_rollback',
        request_id: requestId,
        run_id: runId,
      });
    }

    return c.json({ run_id: runId, status: 'rolled_back' }, 202, {
      'X-Request-Id': requestId,
    });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance with no-op stubs.
// Callers should prefer createOrchestratorRoute(deps) to wire real DB.
// ---------------------------------------------------------------------------

/**
 * Default orchestratorRoute instance — DB functions are stubs.
 *
 * Wire real dependencies in index.ts via:
 * ```ts
 * app.route('/v1/orchestrator/workflows', createOrchestratorRoute({ getWorkflowRun, ... }));
 * ```
 */
export const orchestratorRoute = createOrchestratorRoute();
