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

import { createDb, events, launches, pageTokens, pages, rawEvents } from '@globaltracker/db';
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
  // Hash the hex string — must match auth-public-token middleware which does TextEncoder(rawToken)
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenRaw));
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

  // Auto-promote launch draft → configuring on first page registration (MOD-LAUNCH lifecycle).
  // Idempotent: WHERE clause filters by status='draft', so subsequent pages no-op.
  try {
    await db
      .update(launches)
      .set({ status: 'configuring' })
      .where(and(eq(launches.id, launchId), eq(launches.status, 'draft')));
  } catch (err) {
    safeLog('warn', { event: 'launch_auto_promote_failed', request_id: requestId, error_type: err instanceof Error ? err.constructor.name : typeof err });
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

// GET /v1/pages?launch_public_id=xxx
pagesRoute.get('/', async (c) => {
  const requestId =
    (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
  const workspaceId =
    (c.get('workspace_id') as string | undefined) ??
    c.env.DEV_WORKSPACE_ID ??
    'placeholder-workspace-id';

  const launchPublicId = c.req.query('launch_public_id');
  const db = createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString);

  type PageRow = {
    publicId: string;
    role: string;
    url: string | null;
    allowedDomains: string[];
    status: string;
    createdAt: Date;
  };

  let rows: PageRow[];

  if (launchPublicId) {
    const launchRows = await db
      .select({ id: launches.id })
      .from(launches)
      .where(and(eq(launches.workspaceId, workspaceId), eq(launches.publicId, launchPublicId)))
      .limit(1);
    if (!launchRows[0]) {
      return c.json({ pages: [], request_id: requestId }, 200);
    }
    rows = await db
      .select({
        publicId: pages.publicId,
        role: pages.role,
        url: pages.url,
        allowedDomains: pages.allowedDomains,
        status: pages.status,
        createdAt: pages.createdAt,
      })
      .from(pages)
      .where(and(eq(pages.workspaceId, workspaceId), eq(pages.launchId, launchRows[0].id)))
      .orderBy(pages.createdAt);
  } else {
    rows = await db
      .select({
        publicId: pages.publicId,
        role: pages.role,
        url: pages.url,
        allowedDomains: pages.allowedDomains,
        status: pages.status,
        createdAt: pages.createdAt,
      })
      .from(pages)
      .where(eq(pages.workspaceId, workspaceId))
      .orderBy(pages.createdAt);
  }

  return c.json({
    pages: rows.map((r) => ({
      public_id: r.publicId,
      name: r.publicId,
      role: r.role,
      url: r.url,
      allowed_domains: r.allowedDomains,
      status: r.status,
      created_at: r.createdAt.toISOString(),
    })),
    request_id: requestId,
  }, 200);
});

// PATCH /v1/pages/:page_public_id?launch_public_id=xxx
// Updates url, allowed_domains, status. Workspace-scoped.
const PatchPageSchema = z
  .object({
    url: z.string().url().nullable().optional(),
    allowed_domains: z.array(z.string().min(1)).optional(),
    status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
    event_config: z.record(z.unknown()).optional(),
  })
  .strict();

pagesRoute.patch('/:page_public_id', async (c) => {
  const requestId =
    (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
  const workspaceId =
    (c.get('workspace_id') as string | undefined) ??
    c.env.DEV_WORKSPACE_ID ??
    'placeholder-workspace-id';
  const pagePublicId = c.req.param('page_public_id');
  const launchPublicId = c.req.query('launch_public_id');

  if (!launchPublicId) {
    return c.json(
      { code: 'bad_request', message: 'launch_public_id query required', request_id: requestId },
      400,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = PatchPageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { code: 'bad_request', message: parsed.error.message, request_id: requestId },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString);

  const launchRows = await db
    .select({ id: launches.id })
    .from(launches)
    .where(and(eq(launches.workspaceId, workspaceId), eq(launches.publicId, launchPublicId)))
    .limit(1);
  if (!launchRows[0]) {
    return c.json({ code: 'not_found', message: 'Launch not found', request_id: requestId }, 404);
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.url !== undefined) updates.url = parsed.data.url;
  if (parsed.data.allowed_domains !== undefined) updates.allowedDomains = parsed.data.allowed_domains;
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;
  if (parsed.data.event_config !== undefined) updates.eventConfig = parsed.data.event_config;

  if (Object.keys(updates).length === 0) {
    return c.json({ updated: false, request_id: requestId }, 200);
  }

  updates.updatedAt = new Date();

  const result = await db
    .update(pages)
    .set(updates)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        eq(pages.launchId, launchRows[0].id),
        eq(pages.publicId, pagePublicId),
      ),
    )
    .returning({ id: pages.id });

  if (!result[0]) {
    return c.json({ code: 'not_found', message: 'Page not found', request_id: requestId }, 404);
  }

  safeLog('info', {
    event: 'page_updated',
    request_id: requestId,
    workspace_id: workspaceId,
    page_public_id: pagePublicId,
    launch_public_id: launchPublicId,
    fields: Object.keys(updates),
  });

  return c.json({ updated: true, request_id: requestId }, 200);
});

// DELETE /v1/pages/:page_public_id?launch_public_id=xxx
// Revokes all page_tokens then deletes the page. Workspace-scoped.
pagesRoute.delete('/:page_public_id', async (c) => {
  const requestId =
    (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
  const workspaceId =
    (c.get('workspace_id') as string | undefined) ??
    c.env.DEV_WORKSPACE_ID ??
    'placeholder-workspace-id';
  const pagePublicId = c.req.param('page_public_id');
  const launchPublicId = c.req.query('launch_public_id');

  if (!launchPublicId) {
    return c.json(
      { code: 'bad_request', message: 'launch_public_id query required', request_id: requestId },
      400,
    );
  }

  const db = createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString);

  const launchRows = await db
    .select({ id: launches.id })
    .from(launches)
    .where(and(eq(launches.workspaceId, workspaceId), eq(launches.publicId, launchPublicId)))
    .limit(1);
  if (!launchRows[0]) {
    return c.json({ code: 'not_found', message: 'Launch not found', request_id: requestId }, 404);
  }

  const pageRows = await db
    .select({ id: pages.id })
    .from(pages)
    .where(
      and(
        eq(pages.workspaceId, workspaceId),
        eq(pages.launchId, launchRows[0].id),
        eq(pages.publicId, pagePublicId),
      ),
    )
    .limit(1);
  if (!pageRows[0]) {
    return c.json({ code: 'not_found', message: 'Page not found', request_id: requestId }, 404);
  }
  const pageId = pageRows[0].id;

  await db.delete(rawEvents).where(eq(rawEvents.pageId, pageId));
  await db.delete(events).where(eq(events.pageId, pageId));
  await db.delete(pageTokens).where(eq(pageTokens.pageId, pageId));
  await db.delete(pages).where(eq(pages.id, pageId));

  safeLog('info', {
    event: 'page_deleted',
    request_id: requestId,
    workspace_id: workspaceId,
    page_public_id: pagePublicId,
    launch_public_id: launchPublicId,
  });

  return c.json({ deleted: true, request_id: requestId }, 200);
});

// POST /v1/pages/:page_public_id/tokens — generate a new token for an existing page
pagesRoute.post('/:page_public_id/tokens', async (c) => {
  const requestId =
    (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
  const workspaceId =
    (c.get('workspace_id') as string | undefined) ??
    c.env.DEV_WORKSPACE_ID ??
    'placeholder-workspace-id';

  const pagePublicId = c.req.param('page_public_id');
  const db = createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString);

  const pageRows = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.workspaceId, workspaceId), eq(pages.publicId, pagePublicId)))
    .limit(1);

  if (!pageRows[0]) {
    return c.json({ code: 'not_found', message: 'Page not found', request_id: requestId }, 404);
  }

  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const tokenRaw = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenRaw));
  const tokenHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  try {
    await db.insert(pageTokens).values({
      workspaceId,
      pageId: pageRows[0].id,
      tokenHash,
      label: 'wizard — reissued',
      status: 'active',
    });
  } catch (err) {
    safeLog('error', { event: 'page_token_reissue_error', request_id: requestId, error_type: err instanceof Error ? err.constructor.name : typeof err });
    return c.json({ code: 'internal_error', message: 'Failed to generate token', request_id: requestId }, 500);
  }

  return c.json({ page_token: tokenRaw, page_public_id: pagePublicId, request_id: requestId }, 201);
});

// POST /v1/pages/:page_public_id/rotate-token
// ADR-023: marks current active token as 'rotating' (still valid 14d), creates new 'active' token.
pagesRoute.post('/:page_public_id/rotate-token', async (c) => {
  const requestId =
    (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
  const workspaceId =
    (c.get('workspace_id') as string | undefined) ??
    c.env.DEV_WORKSPACE_ID ??
    'placeholder-workspace-id';

  const pagePublicId = c.req.param('page_public_id');
  const db = createDb(c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString);

  const pageRows = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.workspaceId, workspaceId), eq(pages.publicId, pagePublicId)))
    .limit(1);

  if (!pageRows[0]) {
    return c.json({ code: 'not_found', message: 'Page not found', request_id: requestId }, 404);
  }

  const pageId = pageRows[0].id;

  // Mark all active tokens as rotating
  await db
    .update(pageTokens)
    .set({ status: 'rotating', rotatedAt: new Date() })
    .where(and(eq(pageTokens.pageId, pageId), eq(pageTokens.status, 'active')));

  // Generate new token
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const tokenRaw = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokenRaw));
  const tokenHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  await db.insert(pageTokens).values({
    workspaceId,
    pageId,
    tokenHash,
    label: 'rotated',
    status: 'active',
  });

  safeLog('info', { event: 'page_token_rotated', request_id: requestId, page_public_id: pagePublicId });

  return c.json({ page_token: tokenRaw, page_public_id: pagePublicId, request_id: requestId }, 200);
});
