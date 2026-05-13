/**
 * routes/launches.ts — POST /v1/launches
 *
 * T-FUNIL-011 (Sprint 10): Control-plane endpoint to create a new launch,
 * with optional funnel template scaffolding.
 *
 * Auth:
 *   Authorization: Bearer <api_key> (control-plane pattern).
 *   DEV_WORKSPACE_ID env fallback in dev/test.
 *
 * Fast-accept + scaffold pattern:
 *   1. Validate body (Zod).
 *   2. INSERT INTO launches.
 *   3. If funnel_template_slug present: scaffoldLaunch via waitUntil (async).
 *   4. Return 201 { launch, scaffolded } immediately.
 *
 * Scaffolding is fire-and-forget via executionCtx.waitUntil — it does not
 * block the 201 response. Errors are logged but do not fail the request.
 *
 * BR-PRIVACY-001: no PII in logs or error responses.
 * BR-RBAC-002: workspace isolation — inserts scoped to authenticated workspaceId.
 * INV-LAUNCH-001: (workspace_id, public_id) unique — DB constraint enforces this.
 */

import { createDb } from '@globaltracker/db';
import type { Db } from '@globaltracker/db';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { scaffoldLaunch } from '../lib/funnel-scaffolder.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings / Variables types
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  HYPERDRIVE?: Hyperdrive;
  /** DATABASE_URL for local dev */
  DATABASE_URL?: string;
  /** Dev-only workspace ID bypass */
  DEV_WORKSPACE_ID?: string;
};

type AppVariables = {
  request_id: string;
  workspace_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * Body schema for POST /v1/launches.
 *
 * Required fields: public_id, name.
 * Optional fields: timezone, config, funnel_template_slug.
 */
const CreateLaunchBodySchema = z
  .object({
    /** INV-LAUNCH-001: unique per workspace — 3–64 chars */
    public_id: z.string().min(3).max(64),
    /** Human-readable launch name */
    name: z.string().min(1).max(255),
    /** IANA timezone string. Defaults to America/Sao_Paulo */
    timezone: z.string().optional(),
    /** Tracking config blob (jsonb). Defaults to {} */
    config: z.record(z.unknown()).optional(),
    /**
     * Optional funnel template slug to scaffold pages + audiences.
     * If provided, scaffoldLaunch runs asynchronously via waitUntil.
     */
    funnel_template_slug: z.string().optional(),
  })
  .strict();

type CreateLaunchBody = z.infer<typeof CreateLaunchBodySchema>;

/**
 * Body schema for PATCH /v1/launches/:id.
 *
 * Allows updating funnel_blueprint on an existing launch.
 */
const PatchLaunchBodySchema = z
  .object({
    funnel_blueprint: z.record(z.unknown()),
  })
  .strict();

type PatchLaunchBody = z.infer<typeof PatchLaunchBodySchema>;

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) return null;
  return match[1].trim();
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create the launches sub-router.
 *
 * @param getDb - factory to obtain a Drizzle DB instance from the request context.
 *   Required for DB operations. When absent, returns 503.
 */
export function createLaunchesRoute(
  getDb?: (c: { env: AppBindings }) => Db,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // Auth middleware
  // -------------------------------------------------------------------------
  router.use('*', async (c, next) => {
    const requestId =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    if (!(c.get('request_id' as keyof AppVariables) as string | undefined)) {
      c.set('request_id', requestId);
    }

    const token = extractBearerToken(c.req.header('Authorization'));

    if (!token) {
      return c.json(
        {
          error: 'unauthorized',
          message: 'Authorization: Bearer required',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    // Dev bypass: DEV_WORKSPACE_ID skips DB API key lookup
    if (c.env.DEV_WORKSPACE_ID) {
      c.set('workspace_id', c.env.DEV_WORKSPACE_ID);
      return next();
    }

    // Sprint 10 simplified — token treated as workspace_id (opaque UUID).
    // TODO(T-AUTH-CP): replace with workspace_api_keys lookup.
    c.set('workspace_id', token);
    return next();
  });

  // -------------------------------------------------------------------------
  // POST / — create a new launch
  // -------------------------------------------------------------------------
  router.post('/', async (c) => {
    const requestId = c.get('request_id');
    const workspaceId = c.get('workspace_id');

    // -----------------------------------------------------------------------
    // Step 1: Parse JSON body
    // -----------------------------------------------------------------------
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          error: 'validation_error',
          details: 'invalid json',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Step 2: Zod validation
    // -----------------------------------------------------------------------
    const parsed = CreateLaunchBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: 'validation_error',
          details: parsed.error.flatten(),
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const body: CreateLaunchBody = parsed.data;

    // -----------------------------------------------------------------------
    // Step 3: Require DB
    // -----------------------------------------------------------------------
    const db = getDb?.(c);

    if (!db) {
      safeLog('warn', {
        event: 'launches_create_no_db',
        request_id: requestId,
        workspace_id: workspaceId,
      });
      return c.json(
        {
          error: 'service_unavailable',
          message: 'DB not configured',
          request_id: requestId,
        },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Step 4: Insert launch
    // INV-LAUNCH-001: unique constraint (workspace_id, public_id) — DB error on conflict.
    // -----------------------------------------------------------------------
    const launchId = crypto.randomUUID();
    const timezone = body.timezone ?? 'America/Sao_Paulo';
    const config = JSON.stringify(body.config ?? {});

    try {
      await db.execute(
        sql`INSERT INTO launches (id, workspace_id, public_id, name, timezone, config, status)
            VALUES (
              ${launchId}::uuid,
              ${workspaceId}::uuid,
              ${body.public_id},
              ${body.name},
              ${timezone},
              ${config}::jsonb,
              'draft'
            )`,
      );
    } catch (err) {
      const errName = err instanceof Error ? err.constructor.name : 'unknown';
      // Check for unique constraint violation (PostgreSQL code 23505)
      const isConflict =
        err instanceof Error &&
        err.message.includes('uq_launches_workspace_public_id');

      safeLog('error', {
        event: 'launches_create_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: errName,
        conflict: isConflict,
      });

      if (isConflict) {
        return c.json(
          {
            error: 'conflict',
            message: 'A launch with this public_id already exists',
            request_id: requestId,
          },
          409,
          { 'X-Request-Id': requestId },
        );
      }

      return c.json({ error: 'internal_error', request_id: requestId }, 500, {
        'X-Request-Id': requestId,
      });
    }

    safeLog('info', {
      event: 'launch_created',
      request_id: requestId,
      workspace_id: workspaceId,
      launch_id: launchId,
    });

    // -----------------------------------------------------------------------
    // Step 5: Fire-and-forget scaffold if funnel_template_slug provided
    // waitUntil ensures the Worker doesn't terminate before scaffold completes.
    // Errors are logged but do not fail this response.
    // -----------------------------------------------------------------------
    const templateSlug = body.funnel_template_slug;
    let scaffolded = false;

    if (templateSlug) {
      scaffolded = true;

      c.executionCtx.waitUntil(
        scaffoldLaunch({
          templateSlug,
          launchId,
          launchPublicId: body.public_id,
          workspaceId,
          db,
        }).catch((err) => {
          safeLog('error', {
            event: 'scaffold_error',
            request_id: requestId,
            workspace_id: workspaceId,
            launch_id: launchId,
            error: String(err),
          });
        }),
      );
    }

    // -----------------------------------------------------------------------
    // Step 6: Return 201 Created
    // -----------------------------------------------------------------------
    const launchResponse = {
      id: launchId,
      public_id: body.public_id,
      name: body.name,
      timezone,
      status: 'draft',
      workspace_id: workspaceId,
    };

    return c.json(
      scaffolded
        ? { launch: launchResponse, scaffolded: true }
        : { launch: launchResponse },
      201,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // GET / — list launches for the authenticated workspace
  // -------------------------------------------------------------------------
  router.get('/', async (c) => {
    const requestId = c.get('request_id');
    const workspaceId = c.get('workspace_id');
    const db = getDb?.(c);

    if (!db) {
      return c.json(
        {
          error: 'service_unavailable',
          message: 'DB not configured',
          request_id: requestId,
        },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    const rows = await db.execute(
      sql`SELECT id, public_id, name, status, config, funnel_blueprint, created_at FROM launches WHERE workspace_id = ${workspaceId}::uuid ORDER BY created_at DESC`,
    );

    type LaunchRow = {
      id: string;
      public_id: string;
      name: string;
      status: string;
      config: unknown;
      funnel_blueprint: unknown;
      created_at: string;
    };
    return c.json(
      {
        launches: (rows as unknown as LaunchRow[]).map((r) => ({
          id: r.id,
          public_id: r.public_id,
          name: r.name,
          status: r.status,
          config: r.config,
          funnel_blueprint: typeof r.funnel_blueprint === 'string'
            ? (() => { try { return JSON.parse(r.funnel_blueprint as string); } catch { return null; } })()
            : r.funnel_blueprint ?? null,
          created_at: r.created_at,
        })),
        request_id: requestId,
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // PATCH /:id — update funnel_blueprint on an existing launch
  // -------------------------------------------------------------------------
  router.patch('/:id', async (c) => {
    const requestId = c.get('request_id');
    const workspaceId = c.get('workspace_id');
    const launchId = c.req.param('id');

    // -----------------------------------------------------------------------
    // Step 1: Parse JSON body
    // -----------------------------------------------------------------------
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          error: 'validation_error',
          details: 'invalid json',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Step 2: Zod validation
    // -----------------------------------------------------------------------
    const parsed = PatchLaunchBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: 'validation_error',
          details: parsed.error.flatten(),
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const body: PatchLaunchBody = parsed.data;

    // -----------------------------------------------------------------------
    // Step 3: Require DB
    // -----------------------------------------------------------------------
    const db = getDb?.(c);

    if (!db) {
      safeLog('warn', {
        event: 'launches_patch_no_db',
        request_id: requestId,
        workspace_id: workspaceId,
      });
      return c.json(
        {
          error: 'service_unavailable',
          message: 'DB not configured',
          request_id: requestId,
        },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Step 4: Update launch — scoped to workspace for isolation (BR-RBAC-002)
    // -----------------------------------------------------------------------
    const blueprintJson = JSON.stringify(body.funnel_blueprint);

    const rows = await db.execute(
      sql`UPDATE launches
          SET funnel_blueprint = ${blueprintJson}::jsonb
          WHERE id = ${launchId}::uuid
            AND workspace_id = ${workspaceId}::uuid
          RETURNING id, public_id`,
    );

    type UpdatedRow = { id: string; public_id: string };
    const updated = (rows as unknown as UpdatedRow[])[0];

    if (!updated) {
      return c.json(
        {
          error: 'not_found',
          message: 'Launch not found',
          request_id: requestId,
        },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    safeLog('info', {
      event: 'launch_funnel_blueprint_updated',
      request_id: requestId,
      workspace_id: workspaceId,
      launch_id: launchId,
    });

    return c.json(
      { launch: { id: updated.id, public_id: updated.public_id } },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // POST /:public_id/scaffold — synchronously scaffold pages + audiences for
  // an existing launch using a funnel template.
  //
  // Unlike the fire-and-forget scaffold on POST /, this endpoint awaits the
  // scaffold operation and returns only after it completes (synchronous).
  //
  // BR-RBAC-002: launch lookup scoped to workspace_id.
  // BR-PRIVACY-001: no PII in logs or error responses.
  // -------------------------------------------------------------------------
  router.post('/:public_id/scaffold', async (c) => {
    const requestId = c.get('request_id');
    const workspaceId = c.get('workspace_id');
    const publicId = c.req.param('public_id');

    // -----------------------------------------------------------------------
    // Step 1: Parse JSON body
    // -----------------------------------------------------------------------
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          error: 'validation_error',
          details: 'invalid json',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Step 2: Zod validation
    // -----------------------------------------------------------------------
    const ScaffoldBodySchema = z
      .object({ funnel_template_slug: z.string().min(1) })
      .strict();

    const parsed = ScaffoldBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: 'validation_error',
          details: parsed.error.flatten(),
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const { funnel_template_slug: templateSlug } = parsed.data;

    // -----------------------------------------------------------------------
    // Step 3: Require DB
    // -----------------------------------------------------------------------
    const db = getDb?.(c);

    if (!db) {
      safeLog('warn', {
        event: 'launches_scaffold_no_db',
        request_id: requestId,
        workspace_id: workspaceId,
      });
      return c.json(
        {
          error: 'service_unavailable',
          message: 'DB not configured',
          request_id: requestId,
        },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Step 4: Fetch launch by public_id scoped to workspace (BR-RBAC-002)
    // -----------------------------------------------------------------------
    type LaunchLookupRow = { id: string; public_id: string };
    let launchRow: LaunchLookupRow | undefined;

    try {
      const rows = await db.execute(
        sql`SELECT id, public_id FROM launches
            WHERE public_id = ${publicId}
              AND workspace_id = ${workspaceId}::uuid
            LIMIT 1`,
      );
      launchRow = (rows as unknown as LaunchLookupRow[])[0];
    } catch (err) {
      safeLog('error', {
        event: 'launches_scaffold_lookup_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
      return c.json(
        { error: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    if (!launchRow) {
      return c.json(
        {
          error: 'not_found',
          message: 'Launch not found',
          request_id: requestId,
        },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Step 5: Scaffold synchronously — await before responding
    // -----------------------------------------------------------------------
    safeLog('info', {
      event: 'scaffold_launch_started',
      request_id: requestId,
      workspace_id: workspaceId,
      launch_id: launchRow.id,
    });

    let pagesCreated: number;
    let audiencesCreated: number;

    try {
      const result = await scaffoldLaunch({
        templateSlug,
        launchId: launchRow.id,
        launchPublicId: publicId,
        workspaceId,
        db,
      });
      pagesCreated = result.pagesCreated;
      audiencesCreated = result.audiencesCreated;
    } catch (err) {
      safeLog('error', {
        event: 'scaffold_launch_error',
        request_id: requestId,
        workspace_id: workspaceId,
        launch_id: launchRow.id,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
      return c.json(
        { error: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    safeLog('info', {
      event: 'scaffold_launch_completed',
      request_id: requestId,
      workspace_id: workspaceId,
      launch_id: launchRow.id,
      pages_created: pagesCreated,
      audiences_created: audiencesCreated,
    });

    // -----------------------------------------------------------------------
    // Step 6: Return 200 with scaffold summary
    // -----------------------------------------------------------------------
    return c.json(
      {
        scaffolded: true,
        pages_created: pagesCreated,
        audiences_created: audiencesCreated,
        request_id: requestId,
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // DELETE /:public_id — remove a launch scoped to the authenticated workspace
  // -------------------------------------------------------------------------
  router.delete('/:public_id', async (c) => {
    const requestId = c.get('request_id');
    const workspaceId = c.get('workspace_id');
    const publicId = c.req.param('public_id');

    const db = getDb?.(c);
    if (!db) {
      return c.json(
        { error: 'service_unavailable', message: 'DB not configured', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    const rows = await db.execute(
      sql`DELETE FROM launches
          WHERE public_id = ${publicId}
            AND workspace_id = ${workspaceId}::uuid
          RETURNING id, public_id`,
    );

    type DeletedRow = { id: string; public_id: string };
    const deleted = (rows as unknown as DeletedRow[])[0];

    if (!deleted) {
      return c.json(
        { error: 'not_found', message: 'Launch not found', request_id: requestId },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    safeLog('info', {
      event: 'launch_deleted',
      request_id: requestId,
      workspace_id: workspaceId,
      launch_public_id: publicId,
    });

    return c.json({ deleted: { public_id: deleted.public_id }, request_id: requestId }, 200, {
      'X-Request-Id': requestId,
    });
  });

  return router;
}

export const launchesRoute = createLaunchesRoute((c) =>
  createDb(c.env.HYPERDRIVE?.connectionString ?? c.env.DATABASE_URL ?? ''),
);
