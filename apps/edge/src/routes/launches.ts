/**
 * routes/launches.ts — POST /v1/launches, GET /v1/launches
 *
 * Control Plane endpoints for launch CRUD.
 * Inline DB via Hyperdrive + DEV_WORKSPACE_ID (dev shortcut).
 * Production: replace DEV_WORKSPACE_ID with workspace_id injected by auth-cp.ts middleware.
 *
 * BR-PRIVACY-001: zero PII in logs.
 * BR-RBAC-002: workspace_id isolation.
 */

import { createDb, launches } from '@globaltracker/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
  DEV_WORKSPACE_ID?: string;
  DATABASE_URL?: string;
};
type AppVariables = { request_id: string; workspace_id?: string };
type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

const CreateLaunchSchema = z.object({
  name: z.string().min(1).max(100),
  public_id: z
    .string()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9-]+$/),
  status: z.enum(['draft', 'configuring', 'live']).default('draft'),
});

export const launchesRoute = new Hono<AppEnv>();

// Auth guard
launchesRoute.use('*', async (c, next) => {
  const auth = c.req.header('Authorization');
  const requestId = (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ code: 'unauthorized', message: 'Missing authorization', request_id: requestId }, 401);
  }
  await next();
});

// POST /v1/launches
launchesRoute.post('/', async (c) => {
  const requestId = (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
  const workspaceId = (c.get('workspace_id') as string | undefined) ?? c.env.DEV_WORKSPACE_ID ?? 'placeholder-workspace-id';

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'validation_error', message: 'Invalid JSON body', request_id: requestId }, 400);
  }

  const parsed = CreateLaunchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'validation_error', message: 'Invalid request body', details: parsed.error.flatten().fieldErrors, request_id: requestId },
      400,
    );
  }

  const { name, public_id, status } = parsed.data;

  safeLog('info', { event: 'launch_create', request_id: requestId, public_id, workspace_id: workspaceId });

  const db = createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString);

  let inserted: typeof launches.$inferSelect[];
  try {
    inserted = await db
      .insert(launches)
      .values({
        workspaceId,
        publicId: public_id,
        name,
        status,
        config: {},
        timezone: 'America/Sao_Paulo',
      })
      .returning();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('uq_launches_workspace_public_id') || msg.includes('unique')) {
      return c.json({ code: 'conflict', message: 'Launch public_id already exists', request_id: requestId }, 409);
    }
    safeLog('error', { event: 'launch_create_db_error', request_id: requestId, error_type: err instanceof Error ? err.constructor.name : typeof err });
    return c.json({ code: 'internal_error', message: 'Failed to create launch', request_id: requestId }, 500);
  }

  const row = inserted[0];
  if (!row) {
    return c.json({ code: 'internal_error', message: 'Insert returned no rows', request_id: requestId }, 500);
  }
  return c.json(
    {
      id: row.id,
      launch_public_id: row.publicId,
      public_id: row.publicId,
      name: row.name,
      status: row.status,
      created_at: row.createdAt.toISOString(),
      request_id: requestId,
    },
    201,
  );
});

// GET /v1/launches
launchesRoute.get('/', async (c) => {
  const requestId = (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
  const workspaceId = (c.get('workspace_id') as string | undefined) ?? c.env.DEV_WORKSPACE_ID ?? 'placeholder-workspace-id';

  const db = createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString);
  const rows = await db
    .select({
      id: launches.id,
      publicId: launches.publicId,
      name: launches.name,
      status: launches.status,
      createdAt: launches.createdAt,
    })
    .from(launches)
    .where(eq(launches.workspaceId, workspaceId))
    .orderBy(launches.createdAt);

  return c.json({
    launches: rows.map((r) => ({
      id: r.id,
      public_id: r.publicId,
      name: r.name,
      status: r.status,
      created_at: r.createdAt.toISOString(),
    })),
    request_id: requestId,
  }, 200);
});
