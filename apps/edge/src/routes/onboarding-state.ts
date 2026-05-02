/**
 * routes/onboarding-state.ts — GET /v1/onboarding/state + PATCH /v1/onboarding/state
 *
 * Control Plane endpoints that expose and mutate the onboarding wizard progress
 * stored in `workspaces.onboarding_state` (JSONB).
 *
 * CONTRACT-api-onboarding-state-v1
 *
 * ORCHESTRATOR MOUNT (adicionar em apps/edge/src/index.ts após as outras rotas):
 * import { onboardingStateRoute } from './routes/onboarding-state.js';
 * app.route('/v1/onboarding', onboardingStateRoute);
 *
 * Auth (Sprint 6 placeholder — real JWT validation in auth-cp.ts middleware):
 *   Requires `Authorization: Bearer <token>` header (non-empty).
 *   Missing / empty → 401.
 *
 * GET /v1/onboarding/state
 *   - Reads `onboarding_state` from workspace row.
 *   - Validates shape via OnboardingStateSchema before returning.
 *   - 200: { onboarding_state: OnboardingState }
 *   - 404: workspace not found
 *
 * PATCH /v1/onboarding/state
 *   - Validates body (step + optional fields) via PatchOnboardingSchema.strict().
 *   - Builds a JSONB merge fragment from the step being updated.
 *   - Injects started_at=NOW() when state.started_at is null and step is not skip_all/complete.
 *   - Merges via: onboarding_state = onboarding_state || $fragment::jsonb
 *   - Records audit_log entry with action='onboarding_step_updated'.
 *   - 200: { onboarding_state: OnboardingState } (post-update)
 *   - 400: body validation error
 *
 * BR-PRIVACY-001: zero PII in logs and error responses.
 * BR-RBAC-002: workspace_id is multi-tenant anchor — all queries scoped by workspace_id.
 * BR-AUDIT-001: every mutation generates an audit log entry.
 * INV-WORKSPACE-003: onboarding_state structure validated by Zod before persisting.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  type OnboardingState,
  OnboardingStateSchema,
} from '../../../../packages/shared/src/schemas/onboarding-state.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env types
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
};

type AppVariables = {
  workspace_id: string;
  request_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Zod body schema for PATCH
// ---------------------------------------------------------------------------

/**
 * Validated body for PATCH /v1/onboarding/state.
 * Uses .strict() to reject unknown fields.
 * INV-WORKSPACE-003: validated before merge.
 */
export const PatchOnboardingSchema = z
  .object({
    step: z.enum([
      'meta',
      'ga4',
      'launch',
      'page',
      'install',
      'skip_all',
      'complete',
    ]),
    completed_at: z.string().datetime().optional(),
    validated: z.boolean().optional(),
    launch_id: z.string().uuid().optional(),
    page_id: z.string().uuid().optional(),
    first_ping_at: z.string().datetime().optional(),
    skipped_at: z.string().datetime().optional(),
  })
  .strict();

export type PatchOnboardingBody = z.infer<typeof PatchOnboardingSchema>;

// ---------------------------------------------------------------------------
// Injected DB / audit functions (for testability)
// ---------------------------------------------------------------------------

/**
 * Fetches the `onboarding_state` JSONB column for the given workspace.
 * Returns null when the workspace row is not found.
 * domain-author wires this via Drizzle + Hyperdrive.
 */
export type GetOnboardingStateFn = (
  workspaceId: string,
) => Promise<OnboardingState | null>;

/**
 * Merges the given fragment into `workspaces.onboarding_state` using JSONB
 * concatenation operator (||) and returns the updated state.
 * domain-author wires this via Drizzle + Hyperdrive.
 *
 * SQL equivalent:
 *   UPDATE workspaces
 *   SET onboarding_state = onboarding_state || $fragment::jsonb,
 *       updated_at = NOW()
 *   WHERE id = $workspace_id
 *   RETURNING onboarding_state
 */
export type MergeOnboardingStateFn = (
  workspaceId: string,
  fragment: Record<string, unknown>,
) => Promise<OnboardingState | null>;

/**
 * Inserts an audit log entry.
 * domain-author wires this via apps/edge/src/lib/audit.ts → recordAuditEntry().
 * BR-AUDIT-001: every mutation must generate an audit entry.
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
// Fragment builder
// ---------------------------------------------------------------------------

/**
 * Build the JSONB merge fragment from the validated PATCH body.
 *
 * Rules (docs/70-ux/03-screen-onboarding-wizard.md §7):
 * - 'meta'    → { step_meta: { completed_at, validated } }
 * - 'ga4'     → { step_ga4: { completed_at, validated } }
 * - 'launch'  → { step_launch: { completed_at, launch_id } }
 * - 'page'    → { step_page: { completed_at, page_id } }
 * - 'install' → { step_install: { completed_at, first_ping_at } }
 * - 'skip_all'  → { skipped_at, started_at (if null) }
 * - 'complete'  → { completed_at: NOW() }
 *
 * Also injects started_at=NOW() when currentState.started_at is null and
 * step is not skip_all/complete (so the wizard records when it was begun).
 *
 * INV-WORKSPACE-003: caller parses result with OnboardingStateSchema after merge.
 */
export function buildMergeFragment(
  body: PatchOnboardingBody,
  currentStartedAt: string | undefined | null,
): Record<string, unknown> {
  const now = new Date().toISOString();

  // Inject started_at when it hasn't been set yet and this is a regular step
  const shouldSetStartedAt =
    !currentStartedAt && body.step !== 'skip_all' && body.step !== 'complete';

  const base: Record<string, unknown> = shouldSetStartedAt
    ? { started_at: now }
    : {};

  switch (body.step) {
    case 'meta': {
      const stepData: Record<string, unknown> = {};
      if (body.completed_at !== undefined)
        stepData.completed_at = body.completed_at;
      if (body.validated !== undefined) stepData.validated = body.validated;
      return { ...base, step_meta: stepData };
    }

    case 'ga4': {
      const stepData: Record<string, unknown> = {};
      if (body.completed_at !== undefined)
        stepData.completed_at = body.completed_at;
      if (body.validated !== undefined) stepData.validated = body.validated;
      return { ...base, step_ga4: stepData };
    }

    case 'launch': {
      const stepData: Record<string, unknown> = {};
      if (body.completed_at !== undefined)
        stepData.completed_at = body.completed_at;
      if (body.launch_id !== undefined) stepData.launch_id = body.launch_id;
      return { ...base, step_launch: stepData };
    }

    case 'page': {
      const stepData: Record<string, unknown> = {};
      if (body.completed_at !== undefined)
        stepData.completed_at = body.completed_at;
      if (body.page_id !== undefined) stepData.page_id = body.page_id;
      return { ...base, step_page: stepData };
    }

    case 'install': {
      const stepData: Record<string, unknown> = {};
      if (body.completed_at !== undefined)
        stepData.completed_at = body.completed_at;
      if (body.first_ping_at !== undefined)
        stepData.first_ping_at = body.first_ping_at;
      return { ...base, step_install: stepData };
    }

    case 'skip_all': {
      const skippedAt = body.skipped_at ?? now;
      const fragment: Record<string, unknown> = { skipped_at: skippedAt };
      // Set started_at if not already set (wizard was skipped without starting)
      if (!currentStartedAt) fragment.started_at = now;
      return fragment;
    }

    case 'complete': {
      return { ...base, completed_at: body.completed_at ?? now };
    }
  }
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create the /v1/onboarding sub-router with injected dependencies.
 *
 * Usage in index.ts (wired by orchestrator):
 * ```ts
 * import { createOnboardingStateRoute } from './routes/onboarding-state.js';
 * app.route('/v1/onboarding', createOnboardingStateRoute({ getState, mergeState, insertAuditEntry }));
 * ```
 *
 * @param deps.getState          - fetches onboarding_state for workspace
 * @param deps.mergeState        - merges fragment into onboarding_state, returns updated state
 * @param deps.insertAuditEntry  - records audit log entry
 */
export function createOnboardingStateRoute(deps?: {
  getState?: GetOnboardingStateFn;
  mergeState?: MergeOnboardingStateFn;
  insertAuditEntry?: InsertAuditEntryFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // Shared auth guard
  // TODO Sprint 6: replace with auth-cp.ts middleware that validates Supabase
  // JWT, injects workspace_id and role into context.
  // -------------------------------------------------------------------------
  route.use('*', async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // BR-PRIVACY-001: no PII in 401 response
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing authorization',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    await next();
  });

  // -------------------------------------------------------------------------
  // GET /state
  // CONTRACT-api-onboarding-state-v1
  // -------------------------------------------------------------------------
  route.get('/state', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // BR-RBAC-002: workspace_id from context (set by auth middleware)
    // TODO Sprint 6: workspace_id must come from validated JWT claim.
    const workspaceId =
      (c.get('workspace_id') as string | undefined) ??
      'placeholder-workspace-id'; // TODO Sprint 6: validate JWT Supabase via auth-cp.ts

    safeLog('info', {
      event: 'onboarding_state_get',
      request_id: requestId,
      workspace_id: workspaceId,
    });

    if (!deps?.getState) {
      // No DB wired — return empty state (test/dev stub)
      const emptyState: OnboardingState = {};
      return c.json({ onboarding_state: emptyState }, 200, {
        'X-Request-Id': requestId,
      });
    }

    let rawState: OnboardingState | null;

    try {
      rawState = await deps.getState(workspaceId);
    } catch (err) {
      // BR-PRIVACY-001: no PII in logs
      safeLog('error', {
        event: 'onboarding_state_get_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });

      return c.json(
        {
          code: 'internal_error',
          message: 'Failed to fetch onboarding state',
          request_id: requestId,
        },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    if (rawState === null) {
      return c.json(
        {
          code: 'workspace_not_found',
          message: 'Workspace not found',
          request_id: requestId,
        },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    // INV-WORKSPACE-003: validate shape before returning
    const parseResult = OnboardingStateSchema.safeParse(rawState);
    if (!parseResult.success) {
      safeLog('warn', {
        event: 'onboarding_state_schema_invalid',
        request_id: requestId,
        workspace_id: workspaceId,
      });

      return c.json(
        {
          code: 'internal_error',
          message: 'onboarding_state shape invalid',
          request_id: requestId,
        },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    return c.json({ onboarding_state: parseResult.data }, 200, {
      'X-Request-Id': requestId,
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /state
  // CONTRACT-api-onboarding-state-v1
  // -------------------------------------------------------------------------
  route.patch('/state', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // BR-RBAC-002: workspace_id from context (set by auth middleware)
    // TODO Sprint 6: workspace_id must come from validated JWT claim.
    const workspaceId =
      (c.get('workspace_id') as string | undefined) ??
      'placeholder-workspace-id'; // TODO Sprint 6: validate JWT Supabase via auth-cp.ts

    // Extract actor from Bearer token for audit log
    // BR-PRIVACY-001: Bearer token is opaque reference, not PII
    const authHeader = c.req.header('Authorization') ?? '';
    const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();

    // -----------------------------------------------------------------------
    // 1. Parse + validate body
    //    INV-WORKSPACE-003: Zod strict schema — unknown fields rejected
    // -----------------------------------------------------------------------
    let body: unknown;
    try {
      body = await c.req.json();
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

    const parseResult = PatchOnboardingSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid request body',
          details: parseResult.error.flatten().fieldErrors,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const patchBody = parseResult.data;

    safeLog('info', {
      event: 'onboarding_state_patch',
      request_id: requestId,
      workspace_id: workspaceId,
      step: patchBody.step,
    });

    // -----------------------------------------------------------------------
    // 2. Fetch current state to know started_at (for fragment building)
    // -----------------------------------------------------------------------
    let currentStartedAt: string | null | undefined = undefined;

    if (deps?.getState) {
      try {
        const currentState = await deps.getState(workspaceId);
        if (currentState === null) {
          return c.json(
            {
              code: 'workspace_not_found',
              message: 'Workspace not found',
              request_id: requestId,
            },
            404,
            { 'X-Request-Id': requestId },
          );
        }
        currentStartedAt = currentState.started_at;
      } catch (err) {
        safeLog('error', {
          event: 'onboarding_state_patch_get_error',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });

        return c.json(
          {
            code: 'internal_error',
            message: 'Failed to read onboarding state',
            request_id: requestId,
          },
          500,
          { 'X-Request-Id': requestId },
        );
      }
    }

    // -----------------------------------------------------------------------
    // 3. Build JSONB merge fragment
    //    INV-WORKSPACE-003: fragment is valid sub-shape of OnboardingStateSchema
    // -----------------------------------------------------------------------
    const fragment = buildMergeFragment(patchBody, currentStartedAt);

    // -----------------------------------------------------------------------
    // 4. Apply merge and fetch updated state
    // -----------------------------------------------------------------------
    let updatedState: OnboardingState;

    if (!deps?.mergeState) {
      // No DB wired — return the fragment as mock state (test/dev stub)
      const mockState = OnboardingStateSchema.parse(
        Object.fromEntries(
          Object.entries(fragment).filter(
            ([k]) => k in OnboardingStateSchema.shape,
          ),
        ),
      );
      updatedState = mockState;
    } else {
      let mergeResult: OnboardingState | null;

      try {
        mergeResult = await deps.mergeState(workspaceId, fragment);
      } catch (err) {
        safeLog('error', {
          event: 'onboarding_state_patch_merge_error',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });

        return c.json(
          {
            code: 'internal_error',
            message: 'Failed to update onboarding state',
            request_id: requestId,
          },
          500,
          { 'X-Request-Id': requestId },
        );
      }

      if (mergeResult === null) {
        return c.json(
          {
            code: 'workspace_not_found',
            message: 'Workspace not found',
            request_id: requestId,
          },
          404,
          { 'X-Request-Id': requestId },
        );
      }

      // INV-WORKSPACE-003: validate returned shape
      const stateParseResult = OnboardingStateSchema.safeParse(mergeResult);
      if (!stateParseResult.success) {
        safeLog('warn', {
          event: 'onboarding_state_post_merge_invalid',
          request_id: requestId,
          workspace_id: workspaceId,
        });

        return c.json(
          {
            code: 'internal_error',
            message: 'onboarding_state shape invalid after merge',
            request_id: requestId,
          },
          500,
          { 'X-Request-Id': requestId },
        );
      }

      updatedState = stateParseResult.data;
    }

    // -----------------------------------------------------------------------
    // 5. Audit log
    //    BR-AUDIT-001: every mutation must generate an audit entry.
    //    BR-PRIVACY-001: metadata contains only non-PII identifiers.
    // -----------------------------------------------------------------------
    if (deps?.insertAuditEntry) {
      try {
        await deps.insertAuditEntry({
          action: 'onboarding_step_updated',
          actor_type: 'api_key',
          actor_id: bearerToken,
          entity_type: 'workspace',
          entity_id: workspaceId,
          metadata: {
            step: patchBody.step,
            workspace_id: workspaceId,
            request_id: requestId,
          },
          request_id: requestId,
        });
      } catch (err) {
        // BR-AUDIT-001: log warning but do not fail the mutation
        safeLog('warn', {
          event: '[AUDIT-PENDING] onboarding_step_updated',
          request_id: requestId,
          workspace_id: workspaceId,
          step: patchBody.step,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    } else {
      // BR-AUDIT-001: log pending when audit helper not wired
      safeLog('warn', {
        event: '[AUDIT-PENDING] onboarding_step_updated',
        request_id: requestId,
        workspace_id: workspaceId,
        step: patchBody.step,
      });
    }

    return c.json({ onboarding_state: updatedState }, 200, {
      'X-Request-Id': requestId,
    });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance with no-op stubs.
// Callers should prefer createOnboardingStateRoute(deps) to wire real DB.
// ---------------------------------------------------------------------------

/**
 * Default onboardingStateRoute instance — DB lookups return stub values.
 *
 * Wire real dependencies in index.ts via:
 * ```ts
 * app.route('/v1/onboarding', createOnboardingStateRoute({ getState, mergeState, insertAuditEntry }));
 * ```
 */
export const onboardingStateRoute = createOnboardingStateRoute();
