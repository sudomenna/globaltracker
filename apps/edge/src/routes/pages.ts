/**
 * routes/pages.ts — POST /v1/pages
 *
 * Control Plane endpoint for page creation (onboarding wizard step 4).
 * Inline DB via Hyperdrive + DEV_WORKSPACE_ID (dev shortcut).
 * Production: replace DEV_WORKSPACE_ID with workspace_id injected by auth-cp.ts middleware.
 *
 * BR-PRIVACY-001: zero PII in logs.
 * BR-RBAC-002: workspace_id isolation.
 * INV-PAGE-001: (launch_id, public_id) unique per launch.
 * INV-PAGE-003: token_hash is globally unique (SHA-256 hex, 64 chars).
 */

import { createDb, launches, pageTokens, pages } from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';
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

const CreatePageSchema = z.object({
  name: z.string().min(1).max(100),
  public_id: z
    .string()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9-]+$/),
  launch_public_id: z.string().min(1),
  domains: z.array(z.string().min(1)).min(1),
  mode: z.enum(['b_snippet', 'server']),
  capture_pageview: z.boolean().default(true),
  capture_lead: z.boolean().default(true),
});

export const pagesRoute = new Hono<AppEnv>();

// Auth guard
pagesRoute.use('*', async (c, next) => {
  const auth = c.req.header('Authorization');
  const requestId =
    (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
  if (!auth?.startsWith('Bearer ')) {
    return c.json(
      { code: 'unauthorized', message: 'Missing authorization', request_id: requestId },
      401,
    );
  }
  await next();
});

// POST /v1/pages
pagesRoute.post('/', async (c) => {
  const requestId =
    (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
  const workspaceId =
    (c.get('workspace_id') as string | undefined) ??
    c.env.DEV_WORKSPACE_ID ??
    'placeholder-workspace-id';

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { code: 'validation_error', message: 'Invalid JSON body', request_id: requestId },
      400,
    );
  }

  const parsed = CreatePageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        code: 'validation_error',
        message: 'Invalid request body',
        details: parsed.error.flatten().fieldErrors,
        request_id: requestId,
      },
      400,
    );
  }

  const { name, public_id, launch_public_id, domains, mode, capture_pageview, capture_lead } = parsed.data;

  const db = createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString);

  // Resolve launch UUID from public_id
  const launchRows = await db
    .select({ id: launches.id })
    .from(launches)
    .where(and(eq(launches.workspaceId, workspaceId), eq(launches.publicId, launch_public_id)))
    .limit(1);

  if (!launchRows[0]) {
    return c.json(
      { code: 'launch_not_found', message: `Launch '${launch_public_id}' not found`, request_id: requestId },
      422,
    );
  }

  const launchId = launchRows[0].id;

  // Map wizard mode to integrationMode enum
  const integrationMode = mode === 'server' ? 'c_webhook' : 'b_snippet';

  // Insert page
  let insertedPage: typeof pages.$inferSelect[];
  try {
    insertedPage = await db
      .insert(pages)
      .values({
        workspaceId,
        launchId,
        publicId: public_id,
        role: 'capture',
        integrationMode,
        allowedDomains: domains,
        eventConfig: { capture_pageview, capture_lead },
        status: 'active',
      })
      .returning();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('uq_pages_launch_public_id') || msg.includes('unique')) {
      return c.json({ code: 'conflict', message: 'Page public_id already exists for this launch', request_id: requestId }, 409);
    }
    safeLog('error', { event: 'page_create_db_error', request_id: requestId, error_type: err instanceof Error ? err.constructor.name : typeof err });
    return c.json({ code: 'internal_error', message: 'Failed to create page', request_id: requestId }, 500);
  }

  const page = insertedPage[0];
  if (!page) {
    return c.json({ code: 'internal_error', message: 'Insert returned no rows', request_id: requestId }, 500);
  }

  // Generate page token (32 random bytes → 64-char hex raw token)
  // INV-PAGE-003: store SHA-256 hash (64 chars) — never the raw token
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const tokenRaw = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const hashBuffer = await crypto.subtle.digest('SHA-256', tokenBytes);
  const tokenHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  try {
    await db.insert(pageTokens).values({
      workspaceId,
      pageId: page.id,
      tokenHash,
      label: 'v1 — wizard',
      status: 'active',
    });
  } catch (err) {
    safeLog('error', { event: 'page_token_create_db_error', request_id: requestId, error_type: err instanceof Error ? err.constructor.name : typeof err });
    return c.json({ code: 'internal_error', message: 'Failed to create page token', request_id: requestId }, 500);
  }

  safeLog('info', {
    event: 'page_create',
    request_id: requestId,
    public_id,
    launch_public_id,
    mode,
  });

  return c.json(
    {
      page_public_id: page.publicId,
      public_id: page.publicId,
      name,
      launch_public_id,
      page_token: tokenRaw,
      mode,
      created_at: page.createdAt.toISOString(),
      request_id: requestId,
    },
    201,
  );
});
