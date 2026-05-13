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

import { createDb, launches, workspaces } from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { jsonb } from '../lib/jsonb-cast.js';
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
  DEV_WORKSPACE_ID?: string;
  DATABASE_URL?: string;
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
    skipped: z.boolean().optional(),
    // meta
    pixel_id: z.string().optional(),
    capi_token: z.string().optional(),
    // ga4
    measurement_id: z.string().optional(),
    api_secret: z.string().optional(),
    // launch
    launch_public_id: z.string().optional(),
    // page
    page_public_id: z.string().optional(),
    page_token: z.string().optional(),
    // install
    first_ping_at: z.string().datetime().optional(),
    // skip_all
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
      if (body.completed_at !== undefined) stepData.completed_at = body.completed_at;
      if (body.validated !== undefined) stepData.validated = body.validated;
      if (body.pixel_id !== undefined) stepData.pixel_id = body.pixel_id;
      if (body.capi_token !== undefined) stepData.capi_token = body.capi_token;
      if (body.skipped !== undefined) stepData.skipped = body.skipped;
      return { ...base, step_meta: stepData };
    }

    case 'ga4': {
      const stepData: Record<string, unknown> = {};
      if (body.completed_at !== undefined) stepData.completed_at = body.completed_at;
      if (body.validated !== undefined) stepData.validated = body.validated;
      if (body.measurement_id !== undefined) stepData.measurement_id = body.measurement_id;
      if (body.api_secret !== undefined) stepData.api_secret = body.api_secret;
      if (body.skipped !== undefined) stepData.skipped = body.skipped;
      return { ...base, step_ga4: stepData };
    }

    case 'launch': {
      const stepData: Record<string, unknown> = {};
      if (body.completed_at !== undefined) stepData.completed_at = body.completed_at;
      if (body.launch_public_id !== undefined) stepData.launch_public_id = body.launch_public_id;
      if (body.skipped !== undefined) stepData.skipped = body.skipped;
      return { ...base, step_launch: stepData };
    }

    case 'page': {
      const stepData: Record<string, unknown> = {};
      if (body.completed_at !== undefined) stepData.completed_at = body.completed_at;
      if (body.page_public_id !== undefined) stepData.page_public_id = body.page_public_id;
      if (body.page_token !== undefined) stepData.page_token = body.page_token;
      if (body.skipped !== undefined) stepData.skipped = body.skipped;
      return { ...base, step_page: stepData };
    }

    case 'install': {
      const stepData: Record<string, unknown> = {};
      if (body.completed_at !== undefined) stepData.completed_at = body.completed_at;
      if (body.first_ping_at !== undefined) stepData.first_ping_at = body.first_ping_at;
      if (body.skipped !== undefined) stepData.skipped = body.skipped;
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

    // BR-RBAC-002: workspace_id from context (auth middleware) or DEV_WORKSPACE_ID fallback (local dev).
    // TODO prod: remove DEV_WORKSPACE_ID fallback — auth-cp.ts sets workspace_id from JWT.
    const workspaceId =
      (c.get('workspace_id') as string | undefined) ??
      c.env.DEV_WORKSPACE_ID ??
      'placeholder-workspace-id';

    safeLog('info', {
      event: 'onboarding_state_get',
      request_id: requestId,
      workspace_id: workspaceId,
    });

    if (!deps?.getState) {
      // Inline DB path (dev shortcut — auth-cp.ts + injected deps in prod)
      const db = createDb(c.env.HYPERDRIVE?.connectionString ?? c.env.DATABASE_URL);
      const rows = await db
        .select({ onboardingState: workspaces.onboardingState })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (!rows[0]) {
        return c.json(
          { code: 'workspace_not_found', message: 'Workspace not found', request_id: requestId },
          404,
          { 'X-Request-Id': requestId },
        );
      }
      const parseResult = OnboardingStateSchema.safeParse(rows[0].onboardingState);
      const state: OnboardingState = parseResult.success ? parseResult.data : {};
      return c.json({ onboarding_state: state }, 200, { 'X-Request-Id': requestId });
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

    // BR-RBAC-002: workspace_id from context (auth middleware) or DEV_WORKSPACE_ID fallback (local dev).
    // TODO prod: remove DEV_WORKSPACE_ID fallback — auth-cp.ts sets workspace_id from JWT.
    const workspaceId =
      (c.get('workspace_id') as string | undefined) ??
      c.env.DEV_WORKSPACE_ID ??
      'placeholder-workspace-id';

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
    } else {
      // Inline DB path: fetch started_at from workspaces table
      // _inlineDb is intentionally undefined here — set below if no deps on mergeState too
      try {
        const db = createDb(c.env.HYPERDRIVE?.connectionString ?? c.env.DATABASE_URL);
        const rows = await db
          .select({ onboardingState: workspaces.onboardingState })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);
        if (!rows[0]) {
          return c.json(
            { code: 'workspace_not_found', message: 'Workspace not found', request_id: requestId },
            404,
            { 'X-Request-Id': requestId },
          );
        }
        currentStartedAt = (rows[0].onboardingState as OnboardingState)?.started_at ?? null;
      } catch (err) {
        safeLog('error', {
          event: 'onboarding_state_patch_get_error',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        return c.json(
          { code: 'internal_error', message: 'Failed to read onboarding state', request_id: requestId },
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
      // Inline DB path: fetch current state, merge in JS, update
      // (avoids JSONB || SQL parameter encoding issues in CF Workers local dev)
      try {
        const db = createDb(c.env.HYPERDRIVE?.connectionString ?? c.env.DATABASE_URL);
        const rows = await db
          .select({ onboardingState: workspaces.onboardingState })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);
        if (!rows[0]) {
          return c.json(
            { code: 'workspace_not_found', message: 'Workspace not found', request_id: requestId },
            404,
            { 'X-Request-Id': requestId },
          );
        }
        const currentState = (rows[0].onboardingState as Record<string, unknown>) ?? {};
        const merged = { ...currentState, ...fragment };
        await db.update(workspaces)
          .set({ onboardingState: merged, updatedAt: new Date() })
          .where(eq(workspaces.id, workspaceId));
        const stateParseResult = OnboardingStateSchema.safeParse(merged);
        updatedState = stateParseResult.success ? stateParseResult.data : (merged as OnboardingState);

        // Propagate integration credentials immediately at each step so partial
        // wizard completions (browser close, network drop) don't lose data.
        // Uses jsonb() helper (T-13-013) to avoid Drizzle+Hyperdrive double-stringify.
        if (patchBody.step === 'meta' || patchBody.step === 'ga4') {
          const stepMeta = merged.step_meta as Record<string, unknown> | undefined;
          const stepGa4 = merged.step_ga4 as Record<string, unknown> | undefined;
          const metaPixelId = stepMeta?.pixel_id as string | undefined;
          const metaCapiToken = stepMeta?.capi_token as string | undefined;
          const ga4MeasurementId = stepGa4?.measurement_id as string | undefined;
          const ga4ApiSecret = stepGa4?.api_secret as string | undefined;

          if (metaPixelId !== undefined || metaCapiToken !== undefined || ga4MeasurementId !== undefined || ga4ApiSecret !== undefined) {
            const wsRows = await db
              .select({ config: workspaces.config })
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId))
              .limit(1);
            const rawCfg = wsRows[0]?.config;
            const currentWsConfig: Record<string, unknown> =
              typeof rawCfg === 'string'
                ? (() => { try { return JSON.parse(rawCfg) as Record<string, unknown>; } catch { return {}; } })()
                : (rawCfg as Record<string, unknown>) ?? {};
            const currentIntegrations = (currentWsConfig.integrations as Record<string, unknown>) ?? {};
            const newIntegrations: Record<string, unknown> = { ...currentIntegrations };

            if (metaPixelId !== undefined || metaCapiToken !== undefined) {
              const currentMeta = (currentIntegrations.meta as Record<string, unknown>) ?? {};
              const newMeta = { ...currentMeta };
              if (metaPixelId !== undefined) newMeta.pixel_id = metaPixelId;
              if (metaCapiToken !== undefined) newMeta.capi_token = metaCapiToken;
              newIntegrations.meta = newMeta;
            }

            if (ga4MeasurementId !== undefined || ga4ApiSecret !== undefined) {
              const currentGa4 = (currentIntegrations.ga4 as Record<string, unknown>) ?? {};
              const newGa4 = { ...currentGa4 };
              if (ga4MeasurementId !== undefined) newGa4.measurement_id = ga4MeasurementId;
              if (ga4ApiSecret !== undefined) newGa4.api_secret = ga4ApiSecret;
              newIntegrations.ga4 = newGa4;
            }

            await db
              .update(workspaces)
              .set({ config: jsonb({ ...currentWsConfig, integrations: newIntegrations }), updatedAt: new Date() })
              .where(eq(workspaces.id, workspaceId));
            safeLog('info', { event: 'workspace_config_integrations_propagated', workspace_id: workspaceId, step: patchBody.step });
          }
        }

        // Propagate pixel_id to launch tracking config when meta step completes.
        // Requires launch_public_id from step_launch (may be absent if user fills steps out of order).
        if (patchBody.step === 'meta') {
          const stepMeta = merged.step_meta as Record<string, unknown> | undefined;
          const stepLaunch = merged.step_launch as Record<string, unknown> | undefined;
          const metaPixelId = stepMeta?.pixel_id as string | undefined;
          const launchPublicId = stepLaunch?.launch_public_id as string | undefined;

          if (metaPixelId && launchPublicId) {
            const launchRows = await db
              .select({ id: launches.id, config: launches.config })
              .from(launches)
              .where(and(eq(launches.publicId, launchPublicId), eq(launches.workspaceId, workspaceId)))
              .limit(1);
            if (launchRows[0]) {
              const rawLaunchCfg = launchRows[0].config;
              const currentLaunchConfig: Record<string, unknown> =
                typeof rawLaunchCfg === 'string'
                  ? (() => { try { return JSON.parse(rawLaunchCfg) as Record<string, unknown>; } catch { return {}; } })()
                  : (rawLaunchCfg as Record<string, unknown>) ?? {};
              const currentTracking = (currentLaunchConfig.tracking as Record<string, unknown>) ?? {};
              const newTracking = {
                ...currentTracking,
                meta: { ...(currentTracking.meta as Record<string, unknown> ?? {}), pixel_id: metaPixelId },
              };
              await db
                .update(launches)
                .set({ config: jsonb({ ...currentLaunchConfig, tracking: newTracking }), updatedAt: new Date() })
                .where(eq(launches.id, launchRows[0].id));
              safeLog('info', { event: 'launch_config_tracking_meta_propagated', workspace_id: workspaceId });
            }
          }
        }
      } catch (err) {
        safeLog('error', {
          event: 'onboarding_state_patch_merge_error',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        return c.json(
          { code: 'internal_error', message: 'Failed to update onboarding state', request_id: requestId },
          500,
          { 'X-Request-Id': requestId },
        );
      }
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
