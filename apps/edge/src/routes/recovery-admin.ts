/**
 * routes/recovery-admin.ts — CRUD do Control Plane para o módulo de recovery
 * (cadência de recuperação de carrinho via WhatsApp/Unnichat).
 *
 * T-ID: T-RECOVERY-HYBRID-edge
 *
 * Monta sob `/v1/recovery/*` (passa por cpCors no index.ts). Cobre:
 *   - /v1/recovery/campaigns   (GET, POST, PATCH/:id, DELETE/:id)
 *   - /v1/recovery/templates   (GET, POST, PATCH/:id, DELETE/:id)
 *
 * NÃO confundir com `routes/recovery.ts` (GET launch-scoped legado em
 * /v1/launches/:public_id/recovery) — este arquivo é o CRUD admin global.
 *
 * Auth: Supabase JWT (mesmo padrão de products.ts). workspace_id resolvido
 *   pelo middleware via workspace_members lookup — NUNCA do body/query.
 *
 * BR-RBAC-001/002: workspace_id da auth context. GET ≥ viewer; mutações ≥ admin/owner.
 * BR-AUDIT-001: created_at sempre; created_by populado em templates.
 * BR-PRIVACY-001: recovery não tem PII; respostas de erro não ecoam payload.
 *
 * INV-RECOVERY-CAMPAIGN-001: (workspace_id, name) único → 409.
 * INV-RECOVERY-CAMPAIGN-002: steps array não-vazio de {delay_min,template_id}.
 * INV-RECOVERY-CAMPAIGN-003: recoverable_statuses normalizado UPPERCASE.
 * INV-RECOVERY-CAMPAIGN-004 (CHECK chk_recovery_campaigns_trigger): ≥1 de
 *   (trigger_funnel_role, trigger_product_id).
 * INV-RECOVERY-TEMPLATE-001: (workspace_id, name) único → 409.
 * INV-RECOVERY-TEMPLATE-002: body_params/url_button_params arrays de
 *   {type:'contactName'|'text', fallback?}.
 *
 * DECISÕES:
 *   - Coluna real do id Unnichat no schema é `unnichat_template_id`; exposta no
 *     contrato de API com o mesmo nome (`unnichat_template_id`).
 *   - PATCH /campaigns/:id PERMITE trocar o launch via `launch_public_id`
 *     opcional (re-validado contra o workspace). Omitir mantém o launch atual.
 *
 * CONTRACT: docs/30-contracts/05-api-server-actions.md
 */

import {
  createDb,
  launches,
  products,
  recoveryCampaigns,
  recoveryJobs,
  recoveryTemplates,
  workspaceMembers,
  type Db,
} from '@globaltracker/db';
import { and, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { isValidRole, type WorkspaceRole } from '../lib/rbac.js';
import {
  supabaseJwtMiddleware,
  type LookupWorkspaceMemberFn,
} from '../middleware/auth-supabase-jwt.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings / Variables
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE?: Hyperdrive;
  ENVIRONMENT?: string;
  DATABASE_URL?: string;
  DEV_WORKSPACE_ID?: string;
  SUPABASE_URL?: string;
};

type AppVariables = {
  workspace_id?: string;
  user_id?: string;
  role?: WorkspaceRole;
  request_id?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const StepSchema = z
  .object({
    delay_min: z.number().int().min(0),
    template_id: z.string().uuid(),
  })
  .strict();

// INV-RECOVERY-TEMPLATE-002: cada placeholder é {type, fallback?}.
const ParamSchema = z
  .object({
    type: z.enum(['contactName', 'text']),
    fallback: z.string().optional(),
  })
  .strict();

// time HH:MM ou HH:MM:SS (coluna `time` do Postgres aceita ambos).
const TimeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'must be HH:MM or HH:MM:SS');

const PostCampaignBodySchema = z
  .object({
    launch_public_id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(256),
    trigger_funnel_role: z.string().trim().min(1).max(128).nullish(),
    trigger_product_id: z.string().uuid().nullish(),
    steps: z.array(StepSchema).min(1),
    send_window_start: TimeString.optional(),
    send_window_end: TimeString.optional(),
    send_window_tz: z.string().trim().min(1).max(64).optional(),
    recoverable_statuses: z.array(z.string().trim().min(1)).min(1),
    active: z.boolean().optional(),
    unnichat_sent_tag_id: z.string().trim().min(1).max(256).nullish(),
  })
  .strict()
  .refine(
    (b) =>
      (b.trigger_funnel_role != null && b.trigger_funnel_role !== '') ||
      (b.trigger_product_id != null && b.trigger_product_id !== ''),
    {
      message:
        'At least one of trigger_funnel_role or trigger_product_id is required',
    },
  );

const PatchCampaignBodySchema = z
  .object({
    launch_public_id: z.string().trim().min(1).max(64).optional(),
    name: z.string().trim().min(1).max(256).optional(),
    trigger_funnel_role: z.string().trim().min(1).max(128).nullish(),
    trigger_product_id: z.string().uuid().nullish(),
    steps: z.array(StepSchema).min(1).optional(),
    send_window_start: TimeString.optional(),
    send_window_end: TimeString.optional(),
    send_window_tz: z.string().trim().min(1).max(64).optional(),
    recoverable_statuses: z.array(z.string().trim().min(1)).min(1).optional(),
    active: z.boolean().optional(),
    unnichat_sent_tag_id: z.string().trim().min(1).max(256).nullish(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: 'At least one field must be provided',
  });

const PostTemplateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    unnichat_template_id: z.string().trim().min(1).max(256),
    body_params: z.array(ParamSchema).default([]),
    url_button_params: z.array(ParamSchema).default([]),
    active: z.boolean().optional(),
  })
  .strict();

const PatchTemplateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(256).optional(),
    unnichat_template_id: z.string().trim().min(1).max(256).optional(),
    body_params: z.array(ParamSchema).optional(),
    url_button_params: z.array(ParamSchema).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, {
    message: 'At least one field must be provided',
  });

const ListCampaignsQuerySchema = z
  .object({
    launch_public_id: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ParamItem = z.infer<typeof ParamSchema>;
type StepItem = z.infer<typeof StepSchema>;

function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('uq_recovery_campaigns_workspace_name') ||
    msg.includes('uq_recovery_templates_workspace_name') ||
    msg.includes('23505')
  );
}

function isTriggerCheckViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('chk_recovery_campaigns_trigger');
}

// Defensive parse for jsonb columns read back from DB (may be string or array).
function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? (p as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createRecoveryAdminRoute(opts?: {
  getConnStr?: (env: AppBindings) => string;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  function resolveConnStr(env: AppBindings): string {
    if (opts?.getConnStr) return opts.getConnStr(env);
    return env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL ?? '';
  }

  function resolveDb(env: AppBindings): Db | null {
    const connStr = resolveConnStr(env);
    if (!connStr) return null;
    return createDb(connStr);
  }

  const buildLookupMember = (env: AppBindings): LookupWorkspaceMemberFn => {
    return async (userId: string) => {
      const connStr = resolveConnStr(env);
      if (!connStr) return null;
      const db = createDb(connStr);
      const rows = await db
        .select({
          workspace_id: workspaceMembers.workspaceId,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .limit(1);
      const row = rows[0];
      if (!row || !isValidRole(row.role)) return null;
      return { workspace_id: row.workspace_id, role: row.role };
    };
  };

  route.use('*', async (c, next) => {
    const mw = supabaseJwtMiddleware<AppEnv>({
      lookupMember: buildLookupMember(c.env),
    });
    return mw(c, next);
  });

  // Shared auth context extraction. Returns null + sends response on failure.
  function requireCtx(
    c: Context<AppEnv>,
    requestId: string,
    opts2: { mutate: boolean },
  ):
    | { workspaceId: string; userId: string | undefined; role: WorkspaceRole | null }
    | { error: Response } {
    const workspaceId = c.get('workspace_id') as string | undefined;
    const userId = c.get('user_id') as string | undefined;
    const role = (c.get('role') as WorkspaceRole | undefined) ?? null;

    if (!workspaceId) {
      return {
        error: c.json(
          { code: 'unauthorized', message: 'Missing workspace context', request_id: requestId },
          401,
          { 'X-Request-Id': requestId },
        ),
      };
    }
    if (opts2.mutate) {
      if (!userId) {
        return {
          error: c.json(
            { code: 'unauthorized', message: 'Missing user context', request_id: requestId },
            401,
            { 'X-Request-Id': requestId },
          ),
        };
      }
      if (role !== 'owner' && role !== 'admin') {
        return {
          error: c.json(
            { code: 'forbidden_role', message: 'Requires admin or owner', role, request_id: requestId },
            403,
            { 'X-Request-Id': requestId },
          ),
        };
      }
    }
    return { workspaceId, userId, role };
  }

  // Validate + resolve a launch_public_id to its internal id within the workspace.
  // Returns the launch id, or null if not found in this workspace.
  async function resolveLaunch(
    db: Db,
    workspaceId: string,
    publicId: string,
  ): Promise<{ id: string; name: string } | null> {
    const rows = await db
      .select({ id: launches.id, name: launches.name })
      .from(launches)
      .where(
        and(eq(launches.publicId, publicId), eq(launches.workspaceId, workspaceId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  // Validate that every template_id in steps belongs to the workspace.
  // Returns the first missing id, or null if all valid.
  async function findMissingTemplate(
    db: Db,
    workspaceId: string,
    steps: StepItem[],
  ): Promise<string | null> {
    const ids = [...new Set(steps.map((s) => s.template_id))];
    if (ids.length === 0) return null;
    const rows = await db
      .select({ id: recoveryTemplates.id })
      .from(recoveryTemplates)
      .where(
        and(
          eq(recoveryTemplates.workspaceId, workspaceId),
          sql`${recoveryTemplates.id} = ANY(${ids}::uuid[])`,
        ),
      );
    const found = new Set(rows.map((r) => r.id));
    for (const id of ids) {
      if (!found.has(id)) return id;
    }
    return null;
  }

  // =========================================================================
  // CAMPAIGNS
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /campaigns — list campaigns + per-campaign job stats.
  // BR-RBAC-001: viewer+.
  // -------------------------------------------------------------------------
  route.get('/campaigns', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const ctx = requireCtx(c, requestId, { mutate: false });
    if ('error' in ctx) return ctx.error;
    const { workspaceId } = ctx;

    const parsed = ListCampaignsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          code: 'validation_error',
          message: parsed.error.errors[0]?.message ?? 'Invalid query',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'service_unavailable', message: 'DB not configured', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    try {
      // Stats aggregation: jobs_total + counts per status, grouped by campaign.
      // BR-RBAC-002: scoped by workspace_id.
      const statsSql = sql<{
        campaign_id: string;
        jobs_total: number;
        sent: number;
        queued: number;
        failed: number;
        suppressed: number;
      }>`(
        SELECT
          rj.campaign_id AS campaign_id,
          COUNT(*)::int AS jobs_total,
          COUNT(*) FILTER (WHERE rj.status = 'sent')::int AS sent,
          COUNT(*) FILTER (WHERE rj.status = 'queued')::int AS queued,
          COUNT(*) FILTER (WHERE rj.status = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE rj.status = 'suppressed')::int AS suppressed
        FROM recovery_jobs rj
        WHERE rj.campaign_id = recovery_campaigns.id
        GROUP BY rj.campaign_id
      )`;

      const conds = [eq(recoveryCampaigns.workspaceId, workspaceId)];
      if (parsed.data.launch_public_id) {
        const launch = await resolveLaunch(
          db,
          workspaceId,
          parsed.data.launch_public_id,
        );
        if (!launch) {
          // Unknown launch in this workspace → empty list (not an error).
          return c.json({ items: [] }, 200, { 'X-Request-Id': requestId });
        }
        conds.push(eq(recoveryCampaigns.launchId, launch.id));
      }

      const rows = await db
        .select({
          id: recoveryCampaigns.id,
          launch_id: recoveryCampaigns.launchId,
          launch_public_id: launches.publicId,
          launch_name: launches.name,
          name: recoveryCampaigns.name,
          trigger_funnel_role: recoveryCampaigns.triggerFunnelRole,
          trigger_product_id: recoveryCampaigns.triggerProductId,
          product_name: products.name,
          external_provider: products.externalProvider,
          external_product_id: products.externalProductId,
          steps: recoveryCampaigns.steps,
          send_window_start: recoveryCampaigns.sendWindowStart,
          send_window_end: recoveryCampaigns.sendWindowEnd,
          send_window_tz: recoveryCampaigns.sendWindowTz,
          recoverable_statuses: recoveryCampaigns.recoverableStatuses,
          active: recoveryCampaigns.active,
          unnichat_sent_tag_id: recoveryCampaigns.unnichatSentTagId,
          created_at: recoveryCampaigns.createdAt,
          jobs_total: sql<number>`COALESCE((SELECT s.jobs_total FROM ${statsSql} s), 0)`,
          jobs_sent: sql<number>`COALESCE((SELECT s.sent FROM ${statsSql} s), 0)`,
          jobs_queued: sql<number>`COALESCE((SELECT s.queued FROM ${statsSql} s), 0)`,
          jobs_failed: sql<number>`COALESCE((SELECT s.failed FROM ${statsSql} s), 0)`,
          jobs_suppressed: sql<number>`COALESCE((SELECT s.suppressed FROM ${statsSql} s), 0)`,
        })
        .from(recoveryCampaigns)
        .leftJoin(launches, eq(launches.id, recoveryCampaigns.launchId))
        .leftJoin(products, eq(products.id, recoveryCampaigns.triggerProductId))
        .where(and(...conds))
        .orderBy(sql`${recoveryCampaigns.createdAt} DESC`);

      const items = rows.map((r) => ({
        id: r.id,
        launch_public_id: r.launch_public_id,
        launch_name: r.launch_name,
        name: r.name,
        trigger_funnel_role: r.trigger_funnel_role,
        trigger_product_id: r.trigger_product_id,
        product_name: r.trigger_product_id ? r.product_name : null,
        external_provider: r.trigger_product_id ? r.external_provider : null,
        external_product_id: r.trigger_product_id ? r.external_product_id : null,
        steps: asArray<StepItem>(r.steps),
        send_window_start: r.send_window_start,
        send_window_end: r.send_window_end,
        send_window_tz: r.send_window_tz,
        recoverable_statuses: asArray<string>(r.recoverable_statuses),
        active: r.active,
        unnichat_sent_tag_id: r.unnichat_sent_tag_id,
        created_at: new Date(r.created_at).toISOString(),
        stats: {
          jobs_total: Number(r.jobs_total ?? 0),
          sent: Number(r.jobs_sent ?? 0),
          queued: Number(r.jobs_queued ?? 0),
          failed: Number(r.jobs_failed ?? 0),
          suppressed: Number(r.jobs_suppressed ?? 0),
        },
      }));

      return c.json({ items }, 200, { 'X-Request-Id': requestId });
    } catch (err) {
      safeLog('error', {
        event: 'recovery_campaigns_list_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        { code: 'internal_error', message: 'Failed to list campaigns', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }
  });

  // -------------------------------------------------------------------------
  // POST /campaigns — create.
  // BR-RBAC-001: admin/owner.
  // -------------------------------------------------------------------------
  route.post('/campaigns', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const ctx = requireCtx(c, requestId, { mutate: true });
    if ('error' in ctx) return ctx.error;
    const { workspaceId } = ctx;

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { code: 'validation_error', message: 'Invalid JSON', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const parsed = PostCampaignBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          code: 'validation_error',
          message: parsed.error.errors[0]?.message ?? 'Invalid body',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const body = parsed.data;

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'service_unavailable', message: 'DB not configured', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    try {
      // Resolve + validate launch.
      const launch = await resolveLaunch(db, workspaceId, body.launch_public_id);
      if (!launch) {
        return c.json(
          { code: 'validation_error', message: 'launch_public_id not found in workspace', request_id: requestId },
          400,
          { 'X-Request-Id': requestId },
        );
      }

      // Validate product (when trigger_product_id set).
      if (body.trigger_product_id) {
        const prodRows = await db
          .select({ id: products.id })
          .from(products)
          .where(
            and(
              eq(products.id, body.trigger_product_id),
              eq(products.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        if (!prodRows[0]) {
          return c.json(
            { code: 'validation_error', message: 'trigger_product_id not found in workspace', request_id: requestId },
            400,
            { 'X-Request-Id': requestId },
          );
        }
      }

      // Validate templates referenced by steps.
      const missing = await findMissingTemplate(db, workspaceId, body.steps);
      if (missing) {
        return c.json(
          { code: 'validation_error', message: `steps reference unknown template_id: ${missing}`, request_id: requestId },
          400,
          { 'X-Request-Id': requestId },
        );
      }

      // INV-RECOVERY-CAMPAIGN-003: uppercase normalize.
      const statuses = body.recoverable_statuses.map((s) => s.toUpperCase());

      const inserted = await db
        .insert(recoveryCampaigns)
        .values({
          workspaceId,
          launchId: launch.id,
          name: body.name,
          triggerFunnelRole: body.trigger_funnel_role ?? null,
          triggerProductId: body.trigger_product_id ?? null,
          steps: body.steps,
          sendWindowStart: body.send_window_start ?? undefined,
          sendWindowEnd: body.send_window_end ?? undefined,
          sendWindowTz: body.send_window_tz ?? undefined,
          recoverableStatuses: statuses,
          active: body.active ?? undefined,
          unnichatSentTagId: body.unnichat_sent_tag_id ?? null,
        })
        .returning({
          id: recoveryCampaigns.id,
          name: recoveryCampaigns.name,
          triggerFunnelRole: recoveryCampaigns.triggerFunnelRole,
          triggerProductId: recoveryCampaigns.triggerProductId,
          steps: recoveryCampaigns.steps,
          sendWindowStart: recoveryCampaigns.sendWindowStart,
          sendWindowEnd: recoveryCampaigns.sendWindowEnd,
          sendWindowTz: recoveryCampaigns.sendWindowTz,
          recoverableStatuses: recoveryCampaigns.recoverableStatuses,
          active: recoveryCampaigns.active,
          unnichatSentTagId: recoveryCampaigns.unnichatSentTagId,
          createdAt: recoveryCampaigns.createdAt,
        });

      const created = inserted[0];
      if (!created) {
        return c.json(
          { code: 'internal_error', message: 'Insert returned no row', request_id: requestId },
          500,
          { 'X-Request-Id': requestId },
        );
      }

      return c.json(
        {
          id: created.id,
          launch_public_id: body.launch_public_id,
          launch_name: launch.name,
          name: created.name,
          trigger_funnel_role: created.triggerFunnelRole,
          trigger_product_id: created.triggerProductId,
          steps: asArray<StepItem>(created.steps),
          send_window_start: created.sendWindowStart,
          send_window_end: created.sendWindowEnd,
          send_window_tz: created.sendWindowTz,
          recoverable_statuses: asArray<string>(created.recoverableStatuses),
          active: created.active,
          unnichat_sent_tag_id: created.unnichatSentTagId,
          created_at: new Date(created.createdAt).toISOString(),
        },
        201,
        { 'X-Request-Id': requestId },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json(
          { code: 'conflict', message: 'Já existe uma campanha com este nome neste workspace.', request_id: requestId },
          409,
          { 'X-Request-Id': requestId },
        );
      }
      if (isTriggerCheckViolation(err)) {
        return c.json(
          { code: 'validation_error', message: 'At least one of trigger_funnel_role or trigger_product_id is required', request_id: requestId },
          400,
          { 'X-Request-Id': requestId },
        );
      }
      safeLog('error', {
        event: 'recovery_campaigns_post_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        { code: 'internal_error', message: 'Failed to create campaign', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /campaigns/:id — partial update.
  // Allows changing launch via launch_public_id (re-validated).
  // BR-RBAC-001: admin/owner.
  // -------------------------------------------------------------------------
  route.patch('/campaigns/:id', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const ctx = requireCtx(c, requestId, { mutate: true });
    if ('error' in ctx) return ctx.error;
    const { workspaceId } = ctx;

    const id = c.req.param('id');
    if (!id || id.trim() === '') {
      return c.json(
        { code: 'validation_error', message: 'id is required', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { code: 'validation_error', message: 'Body must be valid JSON', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const parsed = PatchCampaignBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          code: 'validation_error',
          message: parsed.error.errors[0]?.message ?? 'Invalid body',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const body = parsed.data;

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'service_unavailable', message: 'DB not configured', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    try {
      // Load existing row (workspace-scoped).
      const existingRows = await db
        .select({
          id: recoveryCampaigns.id,
          launchId: recoveryCampaigns.launchId,
          triggerFunnelRole: recoveryCampaigns.triggerFunnelRole,
          triggerProductId: recoveryCampaigns.triggerProductId,
        })
        .from(recoveryCampaigns)
        .where(
          and(
            eq(recoveryCampaigns.id, id),
            eq(recoveryCampaigns.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        return c.json(
          { code: 'not_found', message: 'Campaign not found', request_id: requestId },
          404,
          { 'X-Request-Id': requestId },
        );
      }

      // Resolve new launch if provided.
      let newLaunchId = existing.launchId;
      if (body.launch_public_id !== undefined) {
        const launch = await resolveLaunch(db, workspaceId, body.launch_public_id);
        if (!launch) {
          return c.json(
            { code: 'validation_error', message: 'launch_public_id not found in workspace', request_id: requestId },
            400,
            { 'X-Request-Id': requestId },
          );
        }
        newLaunchId = launch.id;
      }

      // Compute effective trigger fields (for CHECK re-validation).
      const effRole =
        body.trigger_funnel_role !== undefined
          ? body.trigger_funnel_role ?? null
          : existing.triggerFunnelRole;
      const effProduct =
        body.trigger_product_id !== undefined
          ? body.trigger_product_id ?? null
          : existing.triggerProductId;

      if (
        (effRole === null || effRole === '') &&
        (effProduct === null || effProduct === '')
      ) {
        return c.json(
          { code: 'validation_error', message: 'At least one of trigger_funnel_role or trigger_product_id is required', request_id: requestId },
          400,
          { 'X-Request-Id': requestId },
        );
      }

      // Validate product if (re)set.
      if (body.trigger_product_id) {
        const prodRows = await db
          .select({ id: products.id })
          .from(products)
          .where(
            and(
              eq(products.id, body.trigger_product_id),
              eq(products.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        if (!prodRows[0]) {
          return c.json(
            { code: 'validation_error', message: 'trigger_product_id not found in workspace', request_id: requestId },
            400,
            { 'X-Request-Id': requestId },
          );
        }
      }

      // Validate templates if steps provided.
      if (body.steps) {
        const missing = await findMissingTemplate(db, workspaceId, body.steps);
        if (missing) {
          return c.json(
            { code: 'validation_error', message: `steps reference unknown template_id: ${missing}`, request_id: requestId },
            400,
            { 'X-Request-Id': requestId },
          );
        }
      }

      // Build update set.
      const updates: Record<string, unknown> = {};
      if (body.launch_public_id !== undefined) updates.launchId = newLaunchId;
      if (body.name !== undefined) updates.name = body.name;
      if (body.trigger_funnel_role !== undefined)
        updates.triggerFunnelRole = body.trigger_funnel_role ?? null;
      if (body.trigger_product_id !== undefined)
        updates.triggerProductId = body.trigger_product_id ?? null;
      if (body.steps !== undefined) updates.steps = body.steps;
      if (body.send_window_start !== undefined)
        updates.sendWindowStart = body.send_window_start;
      if (body.send_window_end !== undefined)
        updates.sendWindowEnd = body.send_window_end;
      if (body.send_window_tz !== undefined)
        updates.sendWindowTz = body.send_window_tz;
      if (body.recoverable_statuses !== undefined)
        updates.recoverableStatuses = body.recoverable_statuses.map((s) =>
          s.toUpperCase(),
        );
      if (body.active !== undefined) updates.active = body.active;
      if (body.unnichat_sent_tag_id !== undefined)
        updates.unnichatSentTagId = body.unnichat_sent_tag_id ?? null;

      const updated = await db
        .update(recoveryCampaigns)
        .set(updates)
        .where(
          and(
            eq(recoveryCampaigns.id, id),
            eq(recoveryCampaigns.workspaceId, workspaceId),
          ),
        )
        .returning({
          id: recoveryCampaigns.id,
          launchId: recoveryCampaigns.launchId,
          name: recoveryCampaigns.name,
          triggerFunnelRole: recoveryCampaigns.triggerFunnelRole,
          triggerProductId: recoveryCampaigns.triggerProductId,
          steps: recoveryCampaigns.steps,
          sendWindowStart: recoveryCampaigns.sendWindowStart,
          sendWindowEnd: recoveryCampaigns.sendWindowEnd,
          sendWindowTz: recoveryCampaigns.sendWindowTz,
          recoverableStatuses: recoveryCampaigns.recoverableStatuses,
          active: recoveryCampaigns.active,
          unnichatSentTagId: recoveryCampaigns.unnichatSentTagId,
          createdAt: recoveryCampaigns.createdAt,
        });

      const row = updated[0];
      if (!row) {
        return c.json(
          { code: 'not_found', message: 'Campaign not found', request_id: requestId },
          404,
          { 'X-Request-Id': requestId },
        );
      }

      // Resolve launch public_id/name for response.
      const launchRows = await db
        .select({ publicId: launches.publicId, name: launches.name })
        .from(launches)
        .where(eq(launches.id, row.launchId))
        .limit(1);

      return c.json(
        {
          id: row.id,
          launch_public_id: launchRows[0]?.publicId ?? null,
          launch_name: launchRows[0]?.name ?? null,
          name: row.name,
          trigger_funnel_role: row.triggerFunnelRole,
          trigger_product_id: row.triggerProductId,
          steps: asArray<StepItem>(row.steps),
          send_window_start: row.sendWindowStart,
          send_window_end: row.sendWindowEnd,
          send_window_tz: row.sendWindowTz,
          recoverable_statuses: asArray<string>(row.recoverableStatuses),
          active: row.active,
          unnichat_sent_tag_id: row.unnichatSentTagId,
          created_at: new Date(row.createdAt).toISOString(),
        },
        200,
        { 'X-Request-Id': requestId },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json(
          { code: 'conflict', message: 'Já existe uma campanha com este nome neste workspace.', request_id: requestId },
          409,
          { 'X-Request-Id': requestId },
        );
      }
      if (isTriggerCheckViolation(err)) {
        return c.json(
          { code: 'validation_error', message: 'At least one of trigger_funnel_role or trigger_product_id is required', request_id: requestId },
          400,
          { 'X-Request-Id': requestId },
        );
      }
      safeLog('error', {
        event: 'recovery_campaigns_patch_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        { code: 'internal_error', message: 'Failed to update campaign', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /campaigns/:id — workspace-scoped. recovery_jobs cascade (FK).
  // BR-RBAC-001: admin/owner.
  // -------------------------------------------------------------------------
  route.delete('/campaigns/:id', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const ctx = requireCtx(c, requestId, { mutate: true });
    if ('error' in ctx) return ctx.error;
    const { workspaceId } = ctx;

    const id = c.req.param('id');
    if (!id || id.trim() === '') {
      return c.json(
        { code: 'validation_error', message: 'id is required', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'service_unavailable', message: 'DB not configured', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    try {
      const deleted = await db
        .delete(recoveryCampaigns)
        .where(
          and(
            eq(recoveryCampaigns.id, id),
            eq(recoveryCampaigns.workspaceId, workspaceId),
          ),
        )
        .returning({ id: recoveryCampaigns.id });

      if (!deleted[0]) {
        return c.json(
          { code: 'not_found', message: 'Campaign not found', request_id: requestId },
          404,
          { 'X-Request-Id': requestId },
        );
      }

      return c.json(
        { id: deleted[0].id, deleted: true },
        200,
        { 'X-Request-Id': requestId },
      );
    } catch (err) {
      safeLog('error', {
        event: 'recovery_campaigns_delete_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        { code: 'internal_error', message: 'Failed to delete campaign', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }
  });

  // =========================================================================
  // TEMPLATES
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /templates — list templates.
  // BR-RBAC-001: viewer+.
  // -------------------------------------------------------------------------
  route.get('/templates', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const ctx = requireCtx(c, requestId, { mutate: false });
    if ('error' in ctx) return ctx.error;
    const { workspaceId } = ctx;

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'service_unavailable', message: 'DB not configured', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    try {
      const rows = await db
        .select({
          id: recoveryTemplates.id,
          name: recoveryTemplates.name,
          unnichat_template_id: recoveryTemplates.unnichatTemplateId,
          body_params: recoveryTemplates.bodyParams,
          url_button_params: recoveryTemplates.urlButtonParams,
          active: recoveryTemplates.active,
          created_by: recoveryTemplates.createdBy,
          created_at: recoveryTemplates.createdAt,
        })
        .from(recoveryTemplates)
        .where(eq(recoveryTemplates.workspaceId, workspaceId))
        .orderBy(sql`${recoveryTemplates.createdAt} DESC`);

      const items = rows.map((r) => ({
        id: r.id,
        name: r.name,
        unnichat_template_id: r.unnichat_template_id,
        body_params: asArray<ParamItem>(r.body_params),
        url_button_params: asArray<ParamItem>(r.url_button_params),
        active: r.active,
        created_by: r.created_by,
        created_at: new Date(r.created_at).toISOString(),
      }));

      return c.json({ items }, 200, { 'X-Request-Id': requestId });
    } catch (err) {
      safeLog('error', {
        event: 'recovery_templates_list_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        { code: 'internal_error', message: 'Failed to list templates', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }
  });

  // -------------------------------------------------------------------------
  // POST /templates — create. created_by = 'user:<uuid>'.
  // BR-RBAC-001: admin/owner. BR-AUDIT-001: created_by proveniência.
  // -------------------------------------------------------------------------
  route.post('/templates', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const ctx = requireCtx(c, requestId, { mutate: true });
    if ('error' in ctx) return ctx.error;
    const { workspaceId, userId } = ctx;

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { code: 'validation_error', message: 'Invalid JSON', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const parsed = PostTemplateBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          code: 'validation_error',
          message: parsed.error.errors[0]?.message ?? 'Invalid body',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const body = parsed.data;

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'service_unavailable', message: 'DB not configured', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    try {
      const inserted = await db
        .insert(recoveryTemplates)
        .values({
          workspaceId,
          name: body.name,
          unnichatTemplateId: body.unnichat_template_id,
          bodyParams: body.body_params,
          urlButtonParams: body.url_button_params,
          active: body.active ?? undefined,
          createdBy: `user:${userId}`,
        })
        .returning({
          id: recoveryTemplates.id,
          name: recoveryTemplates.name,
          unnichatTemplateId: recoveryTemplates.unnichatTemplateId,
          bodyParams: recoveryTemplates.bodyParams,
          urlButtonParams: recoveryTemplates.urlButtonParams,
          active: recoveryTemplates.active,
          createdBy: recoveryTemplates.createdBy,
          createdAt: recoveryTemplates.createdAt,
        });

      const created = inserted[0];
      if (!created) {
        return c.json(
          { code: 'internal_error', message: 'Insert returned no row', request_id: requestId },
          500,
          { 'X-Request-Id': requestId },
        );
      }

      return c.json(
        {
          id: created.id,
          name: created.name,
          unnichat_template_id: created.unnichatTemplateId,
          body_params: asArray<ParamItem>(created.bodyParams),
          url_button_params: asArray<ParamItem>(created.urlButtonParams),
          active: created.active,
          created_by: created.createdBy,
          created_at: new Date(created.createdAt).toISOString(),
        },
        201,
        { 'X-Request-Id': requestId },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json(
          { code: 'conflict', message: 'Já existe um template com este nome neste workspace.', request_id: requestId },
          409,
          { 'X-Request-Id': requestId },
        );
      }
      safeLog('error', {
        event: 'recovery_templates_post_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        { code: 'internal_error', message: 'Failed to create template', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /templates/:id — partial update.
  // BR-RBAC-001: admin/owner.
  // -------------------------------------------------------------------------
  route.patch('/templates/:id', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const ctx = requireCtx(c, requestId, { mutate: true });
    if ('error' in ctx) return ctx.error;
    const { workspaceId } = ctx;

    const id = c.req.param('id');
    if (!id || id.trim() === '') {
      return c.json(
        { code: 'validation_error', message: 'id is required', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { code: 'validation_error', message: 'Body must be valid JSON', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const parsed = PatchTemplateBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          code: 'validation_error',
          message: parsed.error.errors[0]?.message ?? 'Invalid body',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const body = parsed.data;

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'service_unavailable', message: 'DB not configured', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    try {
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.unnichat_template_id !== undefined)
        updates.unnichatTemplateId = body.unnichat_template_id;
      if (body.body_params !== undefined) updates.bodyParams = body.body_params;
      if (body.url_button_params !== undefined)
        updates.urlButtonParams = body.url_button_params;
      if (body.active !== undefined) updates.active = body.active;

      const updated = await db
        .update(recoveryTemplates)
        .set(updates)
        .where(
          and(
            eq(recoveryTemplates.id, id),
            eq(recoveryTemplates.workspaceId, workspaceId),
          ),
        )
        .returning({
          id: recoveryTemplates.id,
          name: recoveryTemplates.name,
          unnichatTemplateId: recoveryTemplates.unnichatTemplateId,
          bodyParams: recoveryTemplates.bodyParams,
          urlButtonParams: recoveryTemplates.urlButtonParams,
          active: recoveryTemplates.active,
          createdBy: recoveryTemplates.createdBy,
          createdAt: recoveryTemplates.createdAt,
        });

      const row = updated[0];
      if (!row) {
        return c.json(
          { code: 'not_found', message: 'Template not found', request_id: requestId },
          404,
          { 'X-Request-Id': requestId },
        );
      }

      return c.json(
        {
          id: row.id,
          name: row.name,
          unnichat_template_id: row.unnichatTemplateId,
          body_params: asArray<ParamItem>(row.bodyParams),
          url_button_params: asArray<ParamItem>(row.urlButtonParams),
          active: row.active,
          created_by: row.createdBy,
          created_at: new Date(row.createdAt).toISOString(),
        },
        200,
        { 'X-Request-Id': requestId },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json(
          { code: 'conflict', message: 'Já existe um template com este nome neste workspace.', request_id: requestId },
          409,
          { 'X-Request-Id': requestId },
        );
      }
      safeLog('error', {
        event: 'recovery_templates_patch_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        { code: 'internal_error', message: 'Failed to update template', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /templates/:id — refuse (409) if referenced by any campaign step.
  // BR-RBAC-001: admin/owner.
  // -------------------------------------------------------------------------
  route.delete('/templates/:id', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const ctx = requireCtx(c, requestId, { mutate: true });
    if ('error' in ctx) return ctx.error;
    const { workspaceId } = ctx;

    const id = c.req.param('id');
    if (!id || id.trim() === '') {
      return c.json(
        { code: 'validation_error', message: 'id is required', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'service_unavailable', message: 'DB not configured', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    try {
      // Ensure template exists in workspace.
      const tplRows = await db
        .select({ id: recoveryTemplates.id })
        .from(recoveryTemplates)
        .where(
          and(
            eq(recoveryTemplates.id, id),
            eq(recoveryTemplates.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (!tplRows[0]) {
        return c.json(
          { code: 'not_found', message: 'Template not found', request_id: requestId },
          404,
          { 'X-Request-Id': requestId },
        );
      }

      // Check if any campaign step references this template_id (jsonb steps[]).
      // BR-RBAC-002: scoped by workspace.
      const refRows = await db.execute(
        sql`SELECT COUNT(*)::int AS n FROM recovery_campaigns rc
            WHERE rc.workspace_id = ${workspaceId}::uuid
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(rc.steps) AS step
                WHERE step->>'template_id' = ${id}
              )`,
      );
      const refRow =
        (refRows as unknown as { rows?: Array<{ n: number }> }).rows?.[0] ??
        (refRows as unknown as Array<{ n: number }>)[0];
      const refCount = Number(refRow?.n ?? 0);

      if (refCount > 0) {
        return c.json(
          {
            code: 'conflict',
            message:
              'Template em uso por uma ou mais campanhas. Remova-o dos steps antes de excluir.',
            request_id: requestId,
          },
          409,
          { 'X-Request-Id': requestId },
        );
      }

      const deleted = await db
        .delete(recoveryTemplates)
        .where(
          and(
            eq(recoveryTemplates.id, id),
            eq(recoveryTemplates.workspaceId, workspaceId),
          ),
        )
        .returning({ id: recoveryTemplates.id });

      if (!deleted[0]) {
        return c.json(
          { code: 'not_found', message: 'Template not found', request_id: requestId },
          404,
          { 'X-Request-Id': requestId },
        );
      }

      return c.json(
        { id: deleted[0].id, deleted: true },
        200,
        { 'X-Request-Id': requestId },
      );
    } catch (err) {
      // FK RESTRICT (recovery_jobs.template_id) → 23503 also means "in use".
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('23503') || msg.includes('recovery_jobs')) {
        return c.json(
          {
            code: 'conflict',
            message: 'Template em uso (jobs de recovery já agendados). Não pode ser excluído.',
            request_id: requestId,
          },
          409,
          { 'X-Request-Id': requestId },
        );
      }
      safeLog('error', {
        event: 'recovery_templates_delete_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        { code: 'internal_error', message: 'Failed to delete template', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance wired via env.
// ---------------------------------------------------------------------------

export const recoveryAdminRoute = createRecoveryAdminRoute();
