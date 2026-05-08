/**
 * routes/products.ts — GET /v1/products + PATCH /v1/products/:id
 *
 * T-ID: T-PRODUCTS-005
 *
 * Catálogo de produtos por workspace. Auto-criados pelos webhooks
 * (Guru/Hotmart/Kiwify/Stripe) com category=NULL; operador depois categoriza
 * via UI. PATCH category dispara backfill de leads afetados (recalcula
 * lifecycle_status via promoteLeadLifecycle — monotônico).
 *
 * Auth: Supabase JWT (igual leads-timeline). workspace_id resolvido pelo
 *   middleware via workspace_members lookup — NUNCA do body/query.
 *
 * BR-PRODUCT-001: lifecycle hierarchy monotônica — promote() só sobe rank.
 * BR-PRODUCT-002: category=NULL → 'cliente' (default conservador).
 * BR-PRODUCT-003: PATCH category dispara backfill de leads afetados.
 * BR-PRIVACY-001: products não tem PII; respostas de erro não ecoam payload.
 * BR-RBAC-001/002: workspace_id da auth context. GET ≥ viewer; PATCH ≥ admin.
 * BR-AUDIT-001 / AUTHZ-012: PATCH grava audit_log.
 *
 * CONTRACT: docs/30-contracts/05-api-server-actions.md
 */

import {
  auditLog,
  createDb,
  products,
  workspaceMembers,
  type Db,
} from '@globaltracker/db';
import { and, asc, desc, eq, ilike, isNull, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  PRODUCT_CATEGORIES,
  isProductCategory,
  lifecycleForCategory,
  type ProductCategory,
} from '../lib/lifecycle-rules.js';
import { promoteLeadLifecycle } from '../lib/lifecycle-promoter.js';
import {
  isValidRole,
  type WorkspaceRole,
} from '../lib/rbac.js';
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

const ProductCategoryEnum = z.enum(
  PRODUCT_CATEGORIES as readonly [ProductCategory, ...ProductCategory[]],
);

const ListProductsQuerySchema = z
  .object({
    status: z.enum(['active', 'archived']).default('active'),
    q: z.string().trim().min(1).max(256).optional(),
    // 'uncategorized' is a sentinel meaning category IS NULL.
    category: z
      .union([ProductCategoryEnum, z.literal('uncategorized')])
      .optional(),
    cursor: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

/**
 * PATCH body — at least one field required (refine).
 * `.strict()` rejects unknown keys.
 * `category: null` is explicit "remove category" (back to uncategorized).
 */
const PatchProductBodySchema = z
  .object({
    category: z.union([ProductCategoryEnum, z.null()]).optional(),
    name: z.string().trim().min(1).max(256).optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.category !== undefined ||
      body.name !== undefined ||
      body.status !== undefined,
    { message: 'At least one of category, name or status must be provided' },
  );

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createProductsRoute(opts?: {
  getConnStr?: (env: AppBindings) => string;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  function resolveConnStr(env: AppBindings): string {
    if (opts?.getConnStr) return opts.getConnStr(env);
    return env.DATABASE_URL ?? env.HYPERDRIVE?.connectionString ?? '';
  }

  function resolveDb(env: AppBindings): Db | null {
    const connStr = resolveConnStr(env);
    if (!connStr) return null;
    return createDb(connStr);
  }

  // -------------------------------------------------------------------------
  // Auth middleware — verifies Supabase JWT and resolves workspace_member.
  // Mirrors leads-timeline.ts pattern. BR-RBAC-002.
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // GET / — list products with cursor pagination + filters + aggregates.
  //
  // BR-RBAC-001/002: workspace_id from auth context; viewer+ allowed.
  // -------------------------------------------------------------------------
  route.get('/', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json(
        { code: 'unauthorized', message: 'Missing workspace context', request_id: requestId },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    const parsed = ListProductsQuerySchema.safeParse(c.req.query());
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

    const { status, q, category, cursor, limit } = parsed.data;

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'service_unavailable', message: 'DB not configured', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    try {
      // Build WHERE clause incrementally — workspace_id always anchored (BR-RBAC-002).
      const conds = [
        eq(products.workspaceId, workspaceId),
        eq(products.status, status),
      ];

      if (q) {
        conds.push(ilike(products.name, `%${q}%`));
      }

      if (category === 'uncategorized') {
        conds.push(isNull(products.category));
      } else if (category) {
        conds.push(eq(products.category, category));
      }

      if (cursor) {
        const cursorDate = new Date(cursor);
        if (Number.isNaN(cursorDate.getTime())) {
          return c.json(
            {
              code: 'validation_error',
              message: 'cursor must be a valid ISO 8601 timestamp',
              request_id: requestId,
            },
            400,
            { 'X-Request-Id': requestId },
          );
        }
        conds.push(lt(products.createdAt, cursorDate));
      }

      // Aggregates via correlated subquery on events.custom_data->>'product_db_id'.
      // BR-RBAC-002: subquery scopes events by same workspace_id.
      // NOTE: column references inline (products.workspace_id / products.id) to ensure
      // Drizzle preserves the correlation to the outer FROM clause.
      const purchaseCountSql = sql<number>`(
        SELECT COUNT(*)::int FROM events e
        WHERE e.workspace_id = products.workspace_id
          AND e.event_name = 'Purchase'
          AND e.custom_data->>'product_db_id' = products.id::text
      )`;

      const affectedLeadsSql = sql<number>`(
        SELECT COUNT(DISTINCT e.lead_id)::int FROM events e
        WHERE e.workspace_id = products.workspace_id
          AND e.event_name = 'Purchase'
          AND e.lead_id IS NOT NULL
          AND e.custom_data->>'product_db_id' = products.id::text
      )`;

      const rows = await db
        .select({
          id: products.id,
          name: products.name,
          category: products.category,
          external_provider: products.externalProvider,
          external_product_id: products.externalProductId,
          status: products.status,
          created_at: products.createdAt,
          updated_at: products.updatedAt,
          purchase_count: purchaseCountSql,
          affected_leads: affectedLeadsSql,
        })
        .from(products)
        .where(and(...conds))
        .orderBy(desc(products.createdAt), asc(products.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? new Date(last.created_at).toISOString() : null;

      const items = page.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        external_provider: r.external_provider,
        external_product_id: r.external_product_id,
        status: r.status,
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
        purchase_count: Number(r.purchase_count ?? 0),
        affected_leads: Number(r.affected_leads ?? 0),
      }));

      return c.json(
        { items, next_cursor: nextCursor },
        200,
        { 'X-Request-Id': requestId },
      );
    } catch (err) {
      // BR-PRIVACY-001: no payload echo in error logs.
      safeLog('error', {
        event: 'products_list_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        { code: 'internal_error', message: 'Failed to list products', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /:id — update name/category/status.
  //
  // BR-PRODUCT-003: when category changes, recalculate lifecycle for every
  //   lead that bought this product.
  // BR-RBAC-001/002: requires admin+ or owner.
  // BR-AUDIT-001 / AUTHZ-012: writes audit_log.
  // -------------------------------------------------------------------------
  route.patch('/:id', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    const workspaceId = c.get('workspace_id') as string | undefined;
    const userId = c.get('user_id') as string | undefined;
    const role = (c.get('role') as WorkspaceRole | undefined) ?? null;

    if (!workspaceId || !userId) {
      return c.json(
        { code: 'unauthorized', message: 'Missing workspace context', request_id: requestId },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    // BR-RBAC-001: PATCH requires admin+ or owner.
    if (role !== 'owner' && role !== 'admin') {
      return c.json(
        { code: 'forbidden_role', message: 'PATCH requires admin or owner', role, request_id: requestId },
        403,
        { 'X-Request-Id': requestId },
      );
    }

    const productId = c.req.param('id');
    if (!productId || productId.trim() === '') {
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

    const parsed = PatchProductBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      // BR-PRIVACY-001: do not echo raw payload in error.
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
      // 1. SELECT current row (scoped by workspace) — capture previousCategory.
      const existingRows = await db
        .select({
          id: products.id,
          name: products.name,
          category: products.category,
          externalProvider: products.externalProvider,
          externalProductId: products.externalProductId,
          status: products.status,
        })
        .from(products)
        .where(
          and(eq(products.id, productId), eq(products.workspaceId, workspaceId)),
        )
        .limit(1);

      const existing = existingRows[0];
      if (!existing) {
        return c.json(
          { code: 'not_found', message: 'Product not found', request_id: requestId },
          404,
          { 'X-Request-Id': requestId },
        );
      }

      const previousCategory = existing.category;
      const categoryChanged =
        body.category !== undefined && body.category !== previousCategory;
      const newCategory =
        body.category !== undefined ? body.category : previousCategory;

      // 2. UPDATE.
      const updates: Partial<{
        category: string | null;
        name: string;
        status: string;
        updatedAt: Date;
      }> = { updatedAt: new Date() };
      if (body.category !== undefined) updates.category = body.category;
      if (body.name !== undefined) updates.name = body.name;
      if (body.status !== undefined) updates.status = body.status;

      await db
        .update(products)
        .set(updates)
        .where(
          and(eq(products.id, productId), eq(products.workspaceId, workspaceId)),
        );

      // 3. BR-PRODUCT-003: backfill lifecycle for affected leads when category changes.
      let leadsRecalculated = 0;
      if (categoryChanged) {
        // Resolve target lifecycle. Type guard (newCategory may be null = uncategorized).
        const targetCategory: ProductCategory | null =
          newCategory === null
            ? null
            : isProductCategory(newCategory)
              ? newCategory
              : null;
        const targetLifecycle = lifecycleForCategory(workspaceId, targetCategory);

        // Find affected leads — distinct lead_id from Purchase events tagged with this product.
        // BR-RBAC-002: workspace_id anchored.
        const affectedRows = await db.execute(
          sql`SELECT DISTINCT lead_id FROM events
              WHERE workspace_id = ${workspaceId}::uuid
                AND event_name = 'Purchase'
                AND lead_id IS NOT NULL
                AND custom_data->>'product_db_id' = ${productId}::text`,
        );

        const rows = (
          affectedRows as unknown as { rows?: Array<{ lead_id: string }> }
        ).rows ?? (affectedRows as unknown as Array<{ lead_id: string }>);

        for (const row of rows) {
          if (!row.lead_id) continue;
          try {
            // BR-PRODUCT-001: monotonic — promoteLeadLifecycle only updates if
            //   target rank is strictly higher than current. Idempotent otherwise.
            const result = await promoteLeadLifecycle(db, row.lead_id, targetLifecycle);
            if (result.updated) leadsRecalculated += 1;
          } catch (err) {
            // Non-fatal: log and continue. Lead with non-canonical lifecycle would throw —
            // we shouldn't fail the whole PATCH because of a single bad row.
            safeLog('warn', {
              event: 'products_patch_lifecycle_promote_failed',
              request_id: requestId,
              workspace_id: workspaceId,
              error_type: err instanceof Error ? err.constructor.name : typeof err,
            });
          }
        }
      }

      // 4. Audit log.
      // BR-AUDIT-001 / AUTHZ-012: mutações sensíveis registram audit_log.
      // BR-PRIVACY-001: metadata documenta antes/depois sem PII (products não têm PII).
      try {
        await db.insert(auditLog).values({
          workspaceId,
          actorId: userId,
          actorType: 'user',
          action: categoryChanged
            ? 'product_category_updated'
            : 'product_updated',
          entityType: 'product',
          entityId: productId,
          before: {
            category: previousCategory,
            name: existing.name,
            status: existing.status,
          },
          after: {
            category: newCategory,
            name: body.name ?? existing.name,
            status: body.status ?? existing.status,
            ...(categoryChanged ? { leads_recalculated: leadsRecalculated } : {}),
          },
          requestContext: { request_id: requestId },
        });
      } catch (auditErr) {
        // Non-fatal — product is already updated.
        safeLog('warn', {
          event: '[AUDIT-PENDING] product_updated',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type:
            auditErr instanceof Error ? auditErr.constructor.name : typeof auditErr,
        });
      }

      const response: Record<string, unknown> = {
        id: productId,
        name: body.name ?? existing.name,
        category: newCategory,
        external_provider: existing.externalProvider,
        external_product_id: existing.externalProductId,
        status: body.status ?? existing.status,
      };
      if (categoryChanged) {
        response.leads_recalculated = leadsRecalculated;
      }

      return c.json(response, 200, { 'X-Request-Id': requestId });
    } catch (err) {
      // BR-PRIVACY-001: no payload echo.
      safeLog('error', {
        event: 'products_patch_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        { code: 'internal_error', message: 'Failed to update product', request_id: requestId },
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

export const productsRoute = createProductsRoute();
